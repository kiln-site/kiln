package main

import (
	"bytes"
	"encoding/binary"
	"io"
	"log"
	"net"
	"strings"
	"sync"
	"testing"
	"time"
)

// A gate in front of a fake database, which records what reaches it and
// answers as the test says.
type harness struct {
	gate     string
	output   *output
	upstream chan net.Conn
}

func start(t *testing.T, protocol string, maxConnections int, timeout time.Duration) *harness {
	t.Helper()
	database, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { database.Close() })
	accepted := make(chan net.Conn, 4)
	go func() {
		for {
			connection, err := database.Accept()
			if err != nil {
				return
			}
			accepted <- connection
		}
	}()
	said := &output{}
	g, err := newGate(protocol, database.Addr().String(), maxConnections, timeout, log.New(said, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	go g.serve(listener)
	return &harness{gate: listener.Addr().String(), output: said, upstream: accepted}
}

// What the gate printed, written from its connections' goroutines.
type output struct {
	mutex sync.Mutex
	lines bytes.Buffer
}

func (o *output) Write(p []byte) (int, error) {
	o.mutex.Lock()
	defer o.mutex.Unlock()
	return o.lines.Write(p)
}

func (o *output) String() string {
	o.mutex.Lock()
	defer o.mutex.Unlock()
	return o.lines.String()
}

func (h *harness) connect(t *testing.T) net.Conn {
	t.Helper()
	client, err := net.Dial("tcp", h.gate)
	if err != nil {
		t.Fatal(err)
	}
	client.SetDeadline(time.Now().Add(5 * time.Second))
	t.Cleanup(func() { client.Close() })
	return client
}

func (h *harness) database(t *testing.T) net.Conn {
	t.Helper()
	select {
	case connection := <-h.upstream:
		connection.SetDeadline(time.Now().Add(5 * time.Second))
		t.Cleanup(func() { connection.Close() })
		return connection
	case <-time.After(5 * time.Second):
		t.Fatal("the gate never reached the database")
		return nil
	}
}

// noDatabase checks the gate didn't open a connection to the database.
func (h *harness) noDatabase(t *testing.T) {
	t.Helper()
	select {
	case <-h.upstream:
		t.Fatal("the gate reached the database")
	case <-time.After(100 * time.Millisecond):
	}
}

func read(t *testing.T, connection net.Conn, n int) []byte {
	t.Helper()
	buffer := make([]byte, n)
	if _, err := io.ReadFull(connection, buffer); err != nil {
		t.Fatalf("reading %d bytes: %v", n, err)
	}
	return buffer
}

func write(t *testing.T, connection net.Conn, payload []byte) {
	t.Helper()
	if _, err := connection.Write(payload); err != nil {
		t.Fatal(err)
	}
}

// closed checks the other end hung up, after any bytes it sent first.
func closed(t *testing.T, connection net.Conn) []byte {
	t.Helper()
	rest, err := io.ReadAll(connection)
	if err != nil && !strings.Contains(err.Error(), "reset") {
		t.Fatalf("the connection stayed open: %v", err)
	}
	return rest
}

func eventually(t *testing.T, done func() bool) {
	t.Helper()
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); time.Sleep(10 * time.Millisecond) {
		if done() {
			return
		}
	}
	t.Fatal("it never happened")
}

var clientHello = []byte{0x16, 0x03, 0x01, 0x02, 0x00, 0x01, 0x00, 0x01}

func postgresMessage(code uint32) []byte {
	message := make([]byte, 8)
	binary.BigEndian.PutUint32(message[0:4], 8)
	binary.BigEndian.PutUint32(message[4:8], code)
	return message
}

func postgresStartup() []byte {
	body := []byte("\x00\x03\x00\x00user\x00postgres\x00\x00")
	message := make([]byte, 4, 4+len(body))
	binary.BigEndian.PutUint32(message, uint32(4+len(body)))
	return append(message, body...)
}

func TestPostgresPassesTLSThrough(t *testing.T) {
	h := start(t, protocolPostgres, 8, 5*time.Second)
	client := h.connect(t)
	write(t, client, postgresMessage(postgresSSLRequest))
	database := h.database(t)
	if got := read(t, database, 8); !bytes.Equal(got, postgresMessage(postgresSSLRequest)) {
		t.Fatalf("the database got %x", got)
	}
	write(t, database, []byte{'S'})
	if got := read(t, client, 1); got[0] != 'S' {
		t.Fatalf("the client got %q", got)
	}
	write(t, client, clientHello)
	if got := read(t, database, len(clientHello)); !bytes.Equal(got, clientHello) {
		t.Fatalf("the database got %x", got)
	}
	write(t, database, []byte("server hello"))
	if got := read(t, client, 12); string(got) != "server hello" {
		t.Fatalf("the client got %q", got)
	}
}

func TestPostgresRefusesAPlainStartup(t *testing.T) {
	h := start(t, protocolPostgres, 8, 5*time.Second)
	client := h.connect(t)
	write(t, client, postgresStartup())
	answer := closed(t, client)
	if len(answer) == 0 || answer[0] != 'E' || !bytes.Contains(answer, []byte(refusedMessage)) {
		t.Fatalf("the client got %q", answer)
	}
	h.noDatabase(t)
	if !strings.Contains(h.output.String(), "refused 127.0.0.1: no TLS") {
		t.Fatalf("the gate said %q", h.output.String())
	}
}

func TestPostgresDeclinesGSSAPIThenTakesTLS(t *testing.T) {
	h := start(t, protocolPostgres, 8, 5*time.Second)
	client := h.connect(t)
	write(t, client, postgresMessage(postgresGSSRequest))
	if got := read(t, client, 1); got[0] != 'N' {
		t.Fatalf("the client got %q", got)
	}
	write(t, client, postgresMessage(postgresSSLRequest))
	database := h.database(t)
	if got := read(t, database, 8); !bytes.Equal(got, postgresMessage(postgresSSLRequest)) {
		t.Fatalf("the database got %x", got)
	}
}

func TestPostgresTakesDirectTLS(t *testing.T) {
	h := start(t, protocolPostgres, 8, 5*time.Second)
	client := h.connect(t)
	write(t, client, clientHello)
	database := h.database(t)
	if got := read(t, database, len(clientHello)); !bytes.Equal(got, clientHello) {
		t.Fatalf("the database got %x", got)
	}
}

func TestPostgresRefusesWhenTheDatabaseHasNoTLS(t *testing.T) {
	h := start(t, protocolPostgres, 8, 5*time.Second)
	client := h.connect(t)
	write(t, client, postgresMessage(postgresSSLRequest))
	database := h.database(t)
	read(t, database, 8)
	write(t, database, []byte{'N'})
	answer := closed(t, client)
	if len(answer) == 0 || answer[0] != 'E' {
		t.Fatalf("the client got %q", answer)
	}
}

func TestPostgresRefusesPlainBytesAfterAgreeingToTLS(t *testing.T) {
	h := start(t, protocolPostgres, 8, 5*time.Second)
	client := h.connect(t)
	write(t, client, postgresMessage(postgresSSLRequest))
	database := h.database(t)
	read(t, database, 8)
	write(t, database, []byte{'S'})
	read(t, client, 1)
	write(t, client, postgresStartup())
	closed(t, client)
	if rest := closed(t, database); len(rest) != 0 {
		t.Fatalf("the database got %q", rest)
	}
}

func TestPostgresRefusesAPlainCancelRequest(t *testing.T) {
	h := start(t, protocolPostgres, 8, 5*time.Second)
	client := h.connect(t)
	cancel := make([]byte, 16)
	binary.BigEndian.PutUint32(cancel[0:4], 16)
	binary.BigEndian.PutUint32(cancel[4:8], postgresCancelRequest)
	write(t, client, cancel)
	closed(t, client)
	h.noDatabase(t)
}

func mysqlPacket(sequence byte, payload []byte) []byte {
	header := []byte{byte(len(payload)), byte(len(payload) >> 8), byte(len(payload) >> 16), sequence}
	return append(header, payload...)
}

func mysqlLogin(capabilities uint32, length int) []byte {
	payload := make([]byte, length)
	binary.LittleEndian.PutUint32(payload[0:4], capabilities)
	return mysqlPacket(1, payload)
}

func TestMySQLPassesTLSThrough(t *testing.T) {
	h := start(t, protocolMySQL, 8, 5*time.Second)
	client := h.connect(t)
	database := h.database(t)
	greeting := mysqlPacket(0, []byte("\x0a8.4.13\x00greeting"))
	write(t, database, greeting)
	if got := read(t, client, len(greeting)); !bytes.Equal(got, greeting) {
		t.Fatalf("the client got %q", got)
	}
	request := mysqlLogin(0x000aa200|mysqlClientSSL, mysqlSSLRequestBytes)
	write(t, client, request)
	write(t, client, clientHello)
	want := append(append([]byte{}, request...), clientHello[0])
	if got := read(t, database, len(want)); !bytes.Equal(got, want) {
		t.Fatalf("the database got %x", got)
	}
}

func TestMySQLRefusesAPlainLogin(t *testing.T) {
	h := start(t, protocolMySQL, 8, 5*time.Second)
	client := h.connect(t)
	database := h.database(t)
	write(t, database, mysqlPacket(0, []byte("\x0a8.4.13\x00greeting")))
	read(t, client, 4+len("\x0a8.4.13\x00greeting"))
	// A login: its user and password hash, in the clear.
	write(t, client, mysqlLogin(0x000aa200, 60))
	answer := closed(t, client)
	if len(answer) < 7 || answer[4] != 0xff || binary.LittleEndian.Uint16(answer[5:7]) != mysqlErrorSecureTransport || answer[3] != 2 {
		t.Fatalf("the client got %x", answer)
	}
	if !bytes.Contains(answer, []byte(refusedMessage)) {
		t.Fatalf("the client got %q", answer)
	}
	if rest := closed(t, database); len(rest) != 0 {
		t.Fatalf("the database got %q", rest)
	}
}

func TestMySQLRefusesA32ByteLoginWithoutTLS(t *testing.T) {
	h := start(t, protocolMySQL, 8, 5*time.Second)
	client := h.connect(t)
	database := h.database(t)
	write(t, database, mysqlPacket(0, []byte("\x0a8.4.13\x00greeting")))
	read(t, client, 4+len("\x0a8.4.13\x00greeting"))
	write(t, client, mysqlLogin(0x000aa200, mysqlSSLRequestBytes))
	answer := closed(t, client)
	if len(answer) < 5 || answer[4] != 0xff {
		t.Fatalf("the client got %x", answer)
	}
	if rest := closed(t, database); len(rest) != 0 {
		t.Fatalf("the database got %q", rest)
	}
}

func TestMySQLPassesOnTheDatabasesOwnRefusal(t *testing.T) {
	h := start(t, protocolMySQL, 8, 5*time.Second)
	client := h.connect(t)
	database := h.database(t)
	refusedByDatabase := mysqlPacket(0, []byte("\xff\x10\x04Too many connections"))
	write(t, database, refusedByDatabase)
	if got := closed(t, client); !bytes.Equal(got, refusedByDatabase) {
		t.Fatalf("the client got %q", got)
	}
}

func TestTLSPortPassesTLSThrough(t *testing.T) {
	h := start(t, protocolTLS, 8, 5*time.Second)
	client := h.connect(t)
	write(t, client, clientHello)
	database := h.database(t)
	if got := read(t, database, len(clientHello)); !bytes.Equal(got, clientHello) {
		t.Fatalf("the database got %x", got)
	}
	// Each side's end of sending reaches the other, and the gate is done
	// once both have ended.
	database.Close()
	closed(t, client)
	client.Close()
	eventually(t, func() bool { return strings.Contains(h.output.String(), "closed 127.0.0.1") })
	if out := h.output.String(); !strings.Contains(out, "connected 127.0.0.1") {
		t.Fatalf("the gate said %q", out)
	}
}

func TestTLSPortRefusesAPlainCommand(t *testing.T) {
	h := start(t, protocolTLS, 8, 5*time.Second)
	client := h.connect(t)
	write(t, client, []byte("AUTH kiln secret\r\n"))
	if answer := string(closed(t, client)); answer != "-ERR "+refusedMessage+"\r\n" {
		t.Fatalf("the client got %q", answer)
	}
	h.noDatabase(t)
}

func TestClosesAClientThatNeverAsks(t *testing.T) {
	h := start(t, protocolPostgres, 8, 200*time.Millisecond)
	client := h.connect(t)
	opened := time.Now()
	closed(t, client)
	if waited := time.Since(opened); waited > 3*time.Second {
		t.Fatalf("the gate waited %s", waited)
	}
	h.noDatabase(t)
}

func TestClosesConnectionsPastTheLimit(t *testing.T) {
	h := start(t, protocolTLS, 1, 5*time.Second)
	first := h.connect(t)
	write(t, first, clientHello)
	h.database(t)
	second := h.connect(t)
	closed(t, second)
	eventually(t, func() bool { return strings.Contains(h.output.String(), "too many connections") })
}

func TestSaysWhenTheDatabaseIsAway(t *testing.T) {
	for _, protocol := range []string{protocolPostgres, protocolMySQL} {
		t.Run(protocol, func(t *testing.T) {
			away, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			target := away.Addr().String()
			away.Close()
			g, err := newGate(protocol, target, 8, 2*time.Second, log.New(io.Discard, "", 0))
			if err != nil {
				t.Fatal(err)
			}
			listener, err := net.Listen("tcp", "127.0.0.1:0")
			if err != nil {
				t.Fatal(err)
			}
			defer listener.Close()
			go g.serve(listener)
			client, err := net.Dial("tcp", listener.Addr().String())
			if err != nil {
				t.Fatal(err)
			}
			defer client.Close()
			client.SetDeadline(time.Now().Add(5 * time.Second))
			if protocol == protocolPostgres {
				write(t, client, postgresMessage(postgresSSLRequest))
			}
			if answer := closed(t, client); !bytes.Contains(answer, []byte(unreachableMessage)) {
				t.Fatalf("the client got %q", answer)
			}
		})
	}
}

func TestRefusesAnUnknownProtocol(t *testing.T) {
	if _, err := newGate("http", "127.0.0.1:1", 1, time.Second, log.New(io.Discard, "", 0)); err == nil {
		t.Fatal("the gate took an unknown protocol")
	}
}
