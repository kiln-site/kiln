// Command kiln-database-gate holds a database's public port.
//
// It reads the start of each connection and refuses a client that doesn't
// ask for TLS. TLS ends here, with the certificate for the name the client
// asked for, each of the database's public names having its own, as the
// Relay's Traefik got it; a client that names none gets the first. The gate
// then passes the connection on to the database on its private network: in
// the clear to Postgres, Redis and Valkey, as the database's other clients
// there reach it, and over TLS of its own to MySQL and MariaDB, whose logins
// won't take a password on a connection they don't see as secure. Each
// connection, and each refusal, is a line of its output naming the client's
// address.
//
// The Relay runs one per public database, from its own image, on the
// database's private network and a network of its own that publishes the
// port. It reaches the database by its name there for every connection, so
// it carries on while the database is deployed again. The Relay writes its
// certificates into one file, which it reads again when it changes.
package main

import (
	"bytes"
	"crypto/tls"
	"encoding/binary"
	"encoding/pem"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	refusedMessage     = "This database's public address requires TLS"
	unreachableMessage = "This database can't be reached right now"
)

// The protocols a gate tells TLS apart in: Postgres asks for it in its first
// message, MySQL and MariaDB in their answer to the server's greeting, and
// Redis and Valkey start TLS at once, as any protocol that does would.
const (
	protocolPostgres = "postgres"
	protocolMySQL    = "mysql"
	protocolTLS      = "tls"
)

func main() {
	protocol := flag.String("protocol", "", "postgres, mysql or tls")
	listen := flag.String("listen", "", "the address to listen on, such as :5432")
	target := flag.String("target", "", "the database, such as database-1234:5432")
	certificates := flag.String("certificates", "", "a PEM file of each name's certificate chain, then its key")
	maxConnections := flag.Int("max-connections", 512, "connections open at once")
	handshake := flag.Duration("handshake-timeout", 10*time.Second, "how long a client has to ask for TLS")
	flag.Parse()

	logger := log.New(os.Stdout, "", 0)
	if *listen == "" || *target == "" || *certificates == "" || *maxConnections < 1 {
		logger.Fatal("kiln-database-gate needs -listen, -target, -certificates and a positive -max-connections")
	}
	gate, err := newGate(*protocol, *target, *certificates, *maxConnections, *handshake, logger)
	if err != nil {
		logger.Fatal(err)
	}
	listener, err := net.Listen("tcp", *listen)
	if err != nil {
		logger.Fatal(err)
	}
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGTERM, syscall.SIGINT)
	go func() {
		<-stop
		listener.Close()
	}()
	gate.say("listening on %s for %s", listener.Addr(), *target)
	if err := gate.serve(listener); err != nil {
		logger.Fatal(err)
	}
}

type gate struct {
	handshake    func(client net.Conn) (front, back net.Conn, err error)
	certificates *certificates
	server       *tls.Config
	target       string
	timeout      time.Duration
	slots        chan struct{}
	logger       *log.Logger
}

func newGate(protocol, target, certificatesPath string, maxConnections int, timeout time.Duration, logger *log.Logger) (*gate, error) {
	g := &gate{
		certificates: &certificates{path: certificatesPath},
		target:       target,
		timeout:      timeout,
		slots:        make(chan struct{}, maxConnections),
		logger:       logger,
	}
	g.server = &tls.Config{
		GetCertificate: g.certificates.forClient,
		MinVersion:     tls.VersionTLS12,
	}
	switch protocol {
	case protocolPostgres:
		g.handshake = g.postgres
		// libpq asks for it, and needs it to start TLS at once.
		g.server.NextProtos = []string{"postgresql"}
	case protocolMySQL:
		g.handshake = g.mysql
	case protocolTLS:
		g.handshake = g.tls
	default:
		return nil, fmt.Errorf("unknown protocol %q", protocol)
	}
	return g, nil
}

func (g *gate) say(format string, values ...any) {
	g.logger.Printf("%s %s", time.Now().UTC().Format(time.RFC3339), fmt.Sprintf(format, values...))
}

// serve takes connections until the listener closes. One past the limit is
// closed at once, so a flood can't hold the database's connections.
func (g *gate) serve(listener net.Listener) error {
	for {
		client, err := listener.Accept()
		if err != nil {
			if errors.Is(err, net.ErrClosed) {
				return nil
			}
			// Out of file descriptors, say: wait rather than spin.
			time.Sleep(50 * time.Millisecond)
			continue
		}
		select {
		case g.slots <- struct{}{}:
			go func() {
				defer func() { <-g.slots }()
				g.handle(client)
			}()
		default:
			g.say("refused %s: too many connections", address(client))
			client.Close()
		}
	}
}

// refusal is a client turned away for what it sent, as opposed to one that
// went away or a database that couldn't be reached.
type refusal string

func (r refusal) Error() string { return string(r) }

func (g *gate) handle(client net.Conn) {
	defer client.Close()
	from := address(client)
	client.SetDeadline(time.Now().Add(g.timeout))
	front, back, err := g.handshake(client)
	if err != nil {
		var refused refusal
		if errors.As(err, &refused) {
			g.say("refused %s: %s", from, refused)
		} else {
			g.say("dropped %s: %v", from, err)
		}
		return
	}
	defer front.Close()
	defer back.Close()
	front.SetDeadline(time.Time{})
	back.SetDeadline(time.Time{})
	if name := serverName(front); name != "" {
		g.say("connected %s to %s", from, name)
	} else {
		g.say("connected %s", from)
	}
	opened := time.Now()
	pipe(front, back)
	g.say("closed %s after %s", from, time.Since(opened).Round(time.Second))
}

// dial reaches the database by its name, looked up again for each
// connection, by the end of the client's handshake.
func (g *gate) dial() (net.Conn, error) {
	deadline := time.Now().Add(g.timeout)
	upstream, err := (&net.Dialer{Deadline: deadline}).Dial("tcp", g.target)
	if err != nil {
		return nil, fmt.Errorf("the database can't be reached: %w", err)
	}
	upstream.SetDeadline(deadline)
	return upstream, nil
}

// accept ends the client's TLS here; `sent` is what it already sent of its
// handshake.
func (g *gate) accept(client net.Conn, sent []byte) (*tls.Conn, error) {
	connection := tls.Server(&prefixed{Conn: client, head: sent}, g.server)
	if err := connection.Handshake(); err != nil {
		return nil, fmt.Errorf("TLS: %w", err)
	}
	return connection, nil
}

// prefixed is a connection whose first bytes were already read.
type prefixed struct {
	net.Conn
	head []byte
}

func (p *prefixed) Read(buffer []byte) (int, error) {
	if len(p.head) > 0 {
		n := copy(buffer, p.head)
		p.head = p.head[n:]
		return n, nil
	}
	return p.Conn.Read(buffer)
}

// A TLS record carrying a handshake message, as every TLS connection starts.
func isTLSRecord(bytes []byte) bool {
	return len(bytes) >= 2 && bytes[0] == 0x16 && bytes[1] == 0x03
}

// expectTLS reads the first byte the client sends once TLS was agreed on,
// which must start its TLS handshake.
func expectTLS(client net.Conn) ([]byte, error) {
	first := make([]byte, 1)
	if _, err := io.ReadFull(client, first); err != nil {
		return nil, err
	}
	if first[0] != 0x16 {
		return nil, refusal("it agreed to TLS, then didn't start it")
	}
	return first, nil
}

// Postgres codes a client opens with, in place of a protocol version.
const (
	postgresCancelRequest = 80877102
	postgresSSLRequest    = 80877103
	postgresGSSRequest    = 80877104
)

// What the client sends once TLS is up, its startup message or a cancel
// request, reaches the database in the clear, as if the client had never
// asked for TLS.
func (g *gate) postgres(client net.Conn) (net.Conn, net.Conn, error) {
	head := make([]byte, 8)
	if _, err := io.ReadFull(client, head); err != nil {
		return nil, nil, err
	}
	// Postgres 17's clients can start TLS at once (sslnegotiation=direct).
	if isTLSRecord(head) {
		return g.secured(client, head)
	}
	length := binary.BigEndian.Uint32(head[0:4])
	code := binary.BigEndian.Uint32(head[4:8])
	// GSSAPI encryption isn't offered; a client then asks for TLS.
	if length == 8 && code == postgresGSSRequest {
		if _, err := client.Write([]byte{'N'}); err != nil {
			return nil, nil, err
		}
		if _, err := io.ReadFull(client, head); err != nil {
			return nil, nil, err
		}
		length = binary.BigEndian.Uint32(head[0:4])
		code = binary.BigEndian.Uint32(head[4:8])
	}
	switch {
	case length == 8 && code == postgresSSLRequest:
		upstream, err := g.dial()
		if err != nil {
			// Said in the clear: the client hasn't started TLS yet.
			client.Write(postgresError(unreachableMessage))
			return nil, nil, err
		}
		front, err := g.agreed(client, []byte{'S'})
		if err != nil {
			upstream.Close()
			return nil, nil, err
		}
		return front, upstream, nil
	case code == postgresCancelRequest:
		// It names the session to cancel in the clear; Postgres 17's clients
		// send it over TLS.
		return nil, nil, refusal("a cancel request without TLS")
	default:
		client.Write(postgresError(refusedMessage))
		return nil, nil, refusal("no TLS")
	}
}

// agreed tells the client TLS can start, then ends its TLS here.
func (g *gate) agreed(client net.Conn, answer []byte) (*tls.Conn, error) {
	if _, err := client.Write(answer); err != nil {
		return nil, err
	}
	first, err := expectTLS(client)
	if err != nil {
		return nil, err
	}
	return g.accept(client, first)
}

// secured ends a client's TLS that started at once, then reaches the
// database in the clear.
func (g *gate) secured(client net.Conn, head []byte) (net.Conn, net.Conn, error) {
	front, err := g.accept(client, head)
	if err != nil {
		return nil, nil, err
	}
	upstream, err := g.dial()
	if err != nil {
		front.Close()
		return nil, nil, err
	}
	return front, upstream, nil
}

// postgresError is a fatal ErrorResponse, which a client shows as it is.
func postgresError(message string) []byte {
	var fields []byte
	for _, field := range [][2]string{
		{"S", "FATAL"}, {"V", "FATAL"}, {"C", "08004"}, {"M", message},
	} {
		fields = append(fields, field[0][0])
		fields = append(fields, field[1]...)
		fields = append(fields, 0)
	}
	fields = append(fields, 0)
	packet := make([]byte, 5, 5+len(fields))
	packet[0] = 'E'
	binary.BigEndian.PutUint32(packet[1:5], uint32(4+len(fields)))
	return append(packet, fields...)
}

// MySQL's packets: a 3-byte little-endian length, a sequence number, then
// what the length says.
const (
	mysqlClientSSL       = 0x800
	mysqlSSLRequestBytes = 32
	mysqlMaxGreeting     = 64 * 1024
	// ER_SECURE_TRANSPORT_REQUIRED: what MySQL answers a plain connection
	// when it requires TLS itself.
	mysqlErrorSecureTransport = 3159
	// ER_SERVER_SHUTDOWN, which clients take for a server that's away.
	mysqlErrorUnreachable = 1053
)

// The server speaks first, so its greeting reaches the client before the
// client says whether it wants TLS. A client that doesn't is answered as
// MySQL would answer it, and what it sent in the clear never reaches the
// database. One that does asks the database for TLS in the same words, so
// the two sides' packets stay numbered alike; the gate's TLS to the
// database checks no name, as it's reached on its own private network.
func (g *gate) mysql(client net.Conn) (net.Conn, net.Conn, error) {
	upstream, err := g.dial()
	if err != nil {
		// In place of the greeting, as MySQL sends one when it can't serve.
		client.Write(mysqlError(0, unreachableMessage))
		return nil, nil, err
	}
	refuse := func(reason error) (net.Conn, net.Conn, error) {
		upstream.Close()
		return nil, nil, reason
	}
	greeting, err := readMySQLPacket(upstream, mysqlMaxGreeting)
	if err != nil {
		return refuse(err)
	}
	// The database turned it away itself, as when it has too many
	// connections; the client has its reason.
	if greeting[4] == 0xff {
		client.Write(greeting)
		return refuse(refusal("the database refused it"))
	}
	if !mysqlOffersTLS(greeting) {
		client.Write(mysqlError(0, "This database isn't ready for TLS"))
		return refuse(refusal("the database didn't offer TLS"))
	}
	if _, err := client.Write(greeting); err != nil {
		return refuse(err)
	}
	header := make([]byte, 4)
	if _, err := io.ReadFull(client, header); err != nil {
		return refuse(err)
	}
	length := int(header[0]) | int(header[1])<<8 | int(header[2])<<16
	if length != mysqlSSLRequestBytes {
		client.Write(mysqlError(header[3]+1, refusedMessage))
		return refuse(refusal("no TLS"))
	}
	request := make([]byte, length)
	if _, err := io.ReadFull(client, request); err != nil {
		return refuse(err)
	}
	if binary.LittleEndian.Uint32(request[0:4])&mysqlClientSSL == 0 {
		client.Write(mysqlError(header[3]+1, refusedMessage))
		return refuse(refusal("no TLS"))
	}
	front, err := g.agreed(client, nil)
	if err != nil {
		return refuse(err)
	}
	for _, bytes := range [][]byte{header, request} {
		if _, err := upstream.Write(bytes); err != nil {
			front.Close()
			return refuse(err)
		}
	}
	back := tls.Client(upstream, &tls.Config{InsecureSkipVerify: true})
	if err := back.Handshake(); err != nil {
		front.Close()
		return refuse(fmt.Errorf("TLS to the database: %w", err))
	}
	return front, back, nil
}

// Whether a greeting says the server takes TLS: CLIENT_SSL in the lower half
// of its capabilities, after its version, connection ID and first eight
// bytes of its challenge.
func mysqlOffersTLS(greeting []byte) bool {
	payload := greeting[4:]
	end := bytes.IndexByte(payload[1:], 0)
	if end < 0 {
		return false
	}
	at := 1 + end + 1 + 4 + 8 + 1
	if len(payload) < at+2 {
		return false
	}
	return binary.LittleEndian.Uint16(payload[at:at+2])&mysqlClientSSL != 0
}

func readMySQLPacket(connection net.Conn, limit int) ([]byte, error) {
	header := make([]byte, 4)
	if _, err := io.ReadFull(connection, header); err != nil {
		return nil, err
	}
	length := int(header[0]) | int(header[1])<<8 | int(header[2])<<16
	if length == 0 || length > limit {
		return nil, fmt.Errorf("the database sent a %d-byte greeting", length)
	}
	packet := make([]byte, 4+length)
	copy(packet, header)
	if _, err := io.ReadFull(connection, packet[4:]); err != nil {
		return nil, err
	}
	return packet, nil
}

// mysqlError is an ERR packet, which a client shows with its code: the one
// MySQL gives a plain connection when it requires TLS, or, in place of the
// greeting, the one it gives when it can't take a connection.
func mysqlError(sequence byte, message string) []byte {
	code := uint16(mysqlErrorSecureTransport)
	if sequence == 0 {
		code = mysqlErrorUnreachable
	}
	payload := []byte{0xff, 0, 0, '#'}
	binary.LittleEndian.PutUint16(payload[1:3], code)
	payload = append(payload, "HY000"...)
	payload = append(payload, message...)
	header := []byte{byte(len(payload)), byte(len(payload) >> 8), byte(len(payload) >> 16), sequence}
	return append(header, payload...)
}

// Redis and Valkey: the client starts TLS at once.
func (g *gate) tls(client net.Conn) (net.Conn, net.Conn, error) {
	head := make([]byte, 3)
	if _, err := io.ReadFull(client, head); err != nil {
		return nil, nil, err
	}
	if !isTLSRecord(head) {
		// A Redis client sends its password first; the error at least
		// says why it went nowhere.
		client.Write([]byte("-ERR " + refusedMessage + "\r\n"))
		return nil, nil, refusal("no TLS")
	}
	return g.secured(client, head)
}

// pipe copies both ways until both sides are done, passing on each side's
// end of sending, as TLS's close_notify and a database's goodbye rely on.
func pipe(client, upstream net.Conn) {
	var done sync.WaitGroup
	done.Add(2)
	copyHalf := func(to, from net.Conn) {
		defer done.Done()
		io.Copy(to, from)
		if half, ok := to.(interface{ CloseWrite() error }); ok {
			half.CloseWrite()
		} else {
			to.Close()
		}
	}
	go copyHalf(upstream, client)
	go copyHalf(client, upstream)
	done.Wait()
}

// address is the client's IP address, without its port.
func address(connection net.Conn) string {
	host, _, err := net.SplitHostPort(connection.RemoteAddr().String())
	if err != nil {
		return connection.RemoteAddr().String()
	}
	return host
}

// serverName is the name a client asked for, if it said one.
func serverName(connection net.Conn) string {
	if secured, ok := connection.(*tls.Conn); ok {
		return secured.ConnectionState().ServerName
	}
	return ""
}

// certificates are the database's public names', read from the file the
// Relay writes whenever it changes. A file caught partway through being
// written, or empty, leaves the last good ones in use.
type certificates struct {
	path  string
	mutex sync.Mutex
	stamp string
	held  []tls.Certificate
}

func (c *certificates) current() ([]tls.Certificate, error) {
	c.mutex.Lock()
	defer c.mutex.Unlock()
	info, err := os.Stat(c.path)
	if err != nil {
		if len(c.held) > 0 {
			return c.held, nil
		}
		return nil, err
	}
	// Docker keeps the time its archive gives, to the second, and a renewed
	// certificate can be the same size; each write is a new file, though.
	stamp := fmt.Sprintf("%d:%d", info.ModTime().UnixNano(), info.Size())
	if file, ok := info.Sys().(*syscall.Stat_t); ok {
		stamp += fmt.Sprintf(":%d", file.Ino)
	}
	if stamp == c.stamp {
		return c.held, nil
	}
	file, err := os.ReadFile(c.path)
	var held []tls.Certificate
	if err == nil {
		held, err = parseCertificates(file)
	}
	if err != nil {
		if len(c.held) > 0 {
			return c.held, nil
		}
		return nil, err
	}
	c.stamp = stamp
	c.held = held
	return held, nil
}

// forClient picks the certificate for the name the client asked for, or the
// first, which is the database's first name's, for one that named none.
func (c *certificates) forClient(hello *tls.ClientHelloInfo) (*tls.Certificate, error) {
	held, err := c.current()
	if err != nil {
		return nil, fmt.Errorf("no certificate: %w", err)
	}
	name := strings.ToLower(strings.TrimSuffix(hello.ServerName, "."))
	if name != "" {
		for index := range held {
			if held[index].Leaf != nil && held[index].Leaf.VerifyHostname(name) == nil {
				return &held[index], nil
			}
		}
	}
	return &held[0], nil
}

// parseCertificates reads each certificate's chain, leaf first, then its
// key, one after another.
func parseCertificates(file []byte) ([]tls.Certificate, error) {
	var held []tls.Certificate
	var chain []byte
	for {
		block, rest := pem.Decode(file)
		if block == nil {
			break
		}
		file = rest
		encoded := pem.EncodeToMemory(block)
		switch {
		case block.Type == "CERTIFICATE":
			chain = append(chain, encoded...)
		case strings.HasSuffix(block.Type, "PRIVATE KEY"):
			certificate, err := tls.X509KeyPair(chain, encoded)
			if err != nil {
				return nil, err
			}
			held = append(held, certificate)
			chain = nil
		}
	}
	if len(held) == 0 || len(chain) > 0 {
		return nil, errors.New("the certificates file is incomplete")
	}
	return held, nil
}
