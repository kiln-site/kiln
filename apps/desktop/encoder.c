// SPDX-License-Identifier: GPL-2.0-or-later
//
// Turns a Mac's raw pixels into H.264. The Relay can't link x264 itself, so it
// sends what changed here, one connection per viewer, and this keeps the full
// picture, scales it to the viewer's size, and answers each frame with its
// encoded bytes. It's built into the desktop image, and shares the Relay's
// network namespace, so it listens only where the Relay can reach it.
//
// All numbers are big-endian. A connection starts with the 43-byte token, then:
//   0x01 size   u16 source width, source height, frame width, frame height
//   0x02 frame  u8 flags, u16 x, y, width, height, then RGBX pixels
//               answered with a u32 length and that many bytes of H.264
//   0x03 ping   answered with 0x03
#include <arpa/inet.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>

#include <libyuv.h>
#include <x264.h>

#define TOKEN_BYTES 43
// A connection that hasn't shown the token by now is gone.
#define TOKEN_SECONDS 10
#define MESSAGE_SIZE 0x01
#define MESSAGE_FRAME 0x02
#define MESSAGE_PING 0x03
#define FLAG_SHARPEN 0x01
// Four 5K displays, as the Relay holds at most.
#define MAX_SOURCE_PIXELS 60000000ULL
// H.264 level 5.1, which browsers can decode.
#define MAX_FRAME_PIXELS 9437184ULL
#define QUALITY 23
// A still picture goes out once at this quantizer, so text ends up crisp.
#define SHARP_QP 16

struct stream {
  x264_t *encoder;
  x264_picture_t picture;
  uint8_t *pixels;
  uint8_t *source[3];
  int source_width;
  int source_height;
  int width;
  int height;
  int64_t pts;
};

static int read_all(int fd, void *data, size_t size) {
  uint8_t *at = data;
  while (size > 0) {
    ssize_t got = read(fd, at, size);
    if (got <= 0) return 0;
    at += got;
    size -= (size_t)got;
  }
  return 1;
}

static int write_all(int fd, const void *data, size_t size) {
  const uint8_t *at = data;
  while (size > 0) {
    ssize_t put = write(fd, at, size);
    if (put <= 0) return 0;
    at += put;
    size -= (size_t)put;
  }
  return 1;
}

static int read_u16s(int fd, uint16_t *values, int count) {
  if (!read_all(fd, values, sizeof(uint16_t) * (size_t)count)) return 0;
  for (int index = 0; index < count; index += 1) {
    values[index] = ntohs(values[index]);
  }
  return 1;
}

static void close_stream(struct stream *stream) {
  if (stream->encoder) {
    x264_encoder_close(stream->encoder);
    x264_picture_clean(&stream->picture);
  }
  free(stream->pixels);
  free(stream->source[0]);
  memset(stream, 0, sizeof(*stream));
}

static int chroma(int size) { return (size + 1) / 2; }

static int open_stream(struct stream *stream, const uint16_t *size) {
  int source_width = size[0];
  int source_height = size[1];
  int width = size[2];
  int height = size[3];
  uint64_t source_pixels = (uint64_t)source_width * (uint64_t)source_height;
  uint64_t pixels = (uint64_t)width * (uint64_t)height;
  if (source_pixels == 0 || source_pixels > MAX_SOURCE_PIXELS) return 0;
  // Even, as 4:2:0 needs.
  if (pixels == 0 || pixels > MAX_FRAME_PIXELS) return 0;
  if ((width & 1) != 0 || (height & 1) != 0) return 0;
  close_stream(stream);

  x264_param_t param;
  if (x264_param_default_preset(&param, "ultrafast", "zerolatency") < 0) {
    return 0;
  }
  // One thread and one slice: noVNC takes each slice for a whole frame.
  param.i_threads = 1;
  param.b_sliced_threads = 0;
  param.i_width = width;
  param.i_height = height;
  param.i_csp = X264_CSP_I420;
  param.i_fps_num = 30;
  param.i_fps_den = 1;
  param.b_vfr_input = 0;
  param.b_repeat_headers = 1;
  param.b_annexb = 1;
  param.i_keyint_max = X264_KEYINT_MAX_INFINITE;
  param.rc.i_rc_method = X264_RC_CRF;
  param.rc.f_rf_constant = QUALITY;
  param.i_log_level = X264_LOG_NONE;
  // What ABGRToI420 makes, for the browser to convert back.
  param.vui.i_colorprim = 1;
  param.vui.i_transfer = 13;
  param.vui.i_colmatrix = 6;
  param.vui.b_fullrange = 0;
  if (x264_param_apply_profile(&param, "high") < 0) return 0;

  stream->encoder = x264_encoder_open(&param);
  if (!stream->encoder) return 0;
  if (x264_picture_alloc(&stream->picture, X264_CSP_I420, width, height) < 0) {
    x264_encoder_close(stream->encoder);
    stream->encoder = NULL;
    return 0;
  }
  size_t luma = (size_t)source_pixels;
  size_t colour = (size_t)chroma(source_width) * (size_t)chroma(source_height);
  stream->pixels = calloc(luma, 4);
  stream->source[0] = malloc(luma + colour * 2);
  if (!stream->pixels || !stream->source[0]) return 0;
  stream->source[1] = stream->source[0] + luma;
  stream->source[2] = stream->source[1] + colour;
  stream->source_width = source_width;
  stream->source_height = source_height;
  stream->width = width;
  stream->height = height;
  // Black, until the first frame fills it.
  memset(stream->source[0], 16, luma);
  memset(stream->source[1], 128, colour * 2);
  return 1;
}

// Brings the rows that changed into 4:2:0, and scales the whole picture.
static void prepare_picture(struct stream *stream, int top, int rows) {
  int left_over = top & 1;
  top -= left_over;
  rows += left_over;
  if (top + rows < stream->source_height) rows += rows & 1;
  int stride = stream->source_width;
  int colour = chroma(stride);
  x264_image_t *image = &stream->picture.img;
  int scaled =
      stream->source_width != stream->width ||
      stream->source_height != stream->height;
  uint8_t *y = scaled ? stream->source[0] : image->plane[0];
  uint8_t *u = scaled ? stream->source[1] : image->plane[1];
  uint8_t *v = scaled ? stream->source[2] : image->plane[2];
  int y_stride = scaled ? stride : image->i_stride[0];
  int u_stride = scaled ? colour : image->i_stride[1];
  int v_stride = scaled ? colour : image->i_stride[2];
  ABGRToI420(stream->pixels + (size_t)top * (size_t)stride * 4, stride * 4,
             y + (size_t)top * (size_t)y_stride, y_stride,
             u + (size_t)(top / 2) * (size_t)u_stride, u_stride,
             v + (size_t)(top / 2) * (size_t)v_stride, v_stride, stride, rows);
  if (!scaled) return;
  I420Scale(stream->source[0], stride, stream->source[1], colour,
            stream->source[2], colour, stream->source_width,
            stream->source_height, image->plane[0], image->i_stride[0],
            image->plane[1], image->i_stride[1], image->plane[2],
            image->i_stride[2], stream->width, stream->height, kFilterBox);
}

static int encode_frame(struct stream *stream, int fd) {
  uint8_t flags;
  uint16_t area[4];
  if (!read_all(fd, &flags, 1) || !read_u16s(fd, area, 4)) return 0;
  if (!stream->encoder) return 0;
  int x = area[0];
  int y = area[1];
  int width = area[2];
  int height = area[3];
  if (x + width > stream->source_width) return 0;
  if (y + height > stream->source_height) return 0;
  size_t stride = (size_t)stream->source_width * 4;
  for (int row = 0; row < height; row += 1) {
    uint8_t *at = stream->pixels + (size_t)(y + row) * stride + (size_t)x * 4;
    if (!read_all(fd, at, (size_t)width * 4)) return 0;
  }
  if (height > 0) prepare_picture(stream, y, height);

  stream->picture.i_pts = stream->pts;
  stream->pts += 1;
  stream->picture.i_qpplus1 = (flags & FLAG_SHARPEN) ? SHARP_QP + 1 : 0;
  x264_nal_t *nals;
  int nal_count;
  x264_picture_t done;
  int size = x264_encoder_encode(stream->encoder, &nals, &nal_count,
                                 &stream->picture, &done);
  if (size < 0) return 0;
  uint32_t length = htonl((uint32_t)size);
  if (!write_all(fd, &length, sizeof(length))) return 0;
  return size == 0 || write_all(fd, nals[0].p_payload, (size_t)size);
}

static void serve(int fd, const char *token) {
  char offered[TOKEN_BYTES];
  alarm(TOKEN_SECONDS);
  if (!read_all(fd, offered, TOKEN_BYTES)) return;
  alarm(0);
  uint8_t difference = 0;
  for (int index = 0; index < TOKEN_BYTES; index += 1) {
    difference |= (uint8_t)(offered[index] ^ token[index]);
  }
  if (difference != 0) return;

  struct stream stream;
  memset(&stream, 0, sizeof(stream));
  for (;;) {
    uint8_t type;
    if (!read_all(fd, &type, 1)) break;
    if (type == MESSAGE_SIZE) {
      uint16_t size[4];
      if (!read_u16s(fd, size, 4) || !open_stream(&stream, size)) break;
    } else if (type == MESSAGE_FRAME) {
      if (!encode_frame(&stream, fd)) break;
    } else if (type == MESSAGE_PING) {
      if (!write_all(fd, &type, 1)) break;
    } else {
      break;
    }
  }
  close_stream(&stream);
}

int main(int argc, char **argv) {
  const char *token = getenv("KILN_ENCODER_TOKEN");
  if (argc != 2 || !token || strlen(token) != TOKEN_BYTES) {
    fprintf(stderr, "usage: KILN_ENCODER_TOKEN=... kiln-desktop-encoder <port>\n");
    return 2;
  }
  // Each viewer gets a process, so a crash ends only that viewer's stream, and
  // nothing has to wait for them.
  signal(SIGCHLD, SIG_IGN);
  signal(SIGPIPE, SIG_IGN);
  int server = socket(AF_INET, SOCK_STREAM, 0);
  int on = 1;
  setsockopt(server, SOL_SOCKET, SO_REUSEADDR, &on, sizeof(on));
  struct sockaddr_in address;
  memset(&address, 0, sizeof(address));
  address.sin_family = AF_INET;
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  address.sin_port = htons((uint16_t)atoi(argv[1]));
  if (bind(server, (struct sockaddr *)&address, sizeof(address)) < 0 ||
      listen(server, 16) < 0) {
    perror("listen");
    return 1;
  }
  for (;;) {
    int fd = accept(server, NULL, NULL);
    if (fd < 0) continue;
    if (fork() == 0) {
      close(server);
      setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &on, sizeof(on));
      serve(fd, token);
      _exit(0);
    }
    close(fd);
  }
}
