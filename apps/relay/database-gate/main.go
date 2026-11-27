// Command kiln-database-gate holds a database's public port.
//
// It reads the start of each connection and refuses a client that doesn't
// ask for TLS, then passes every byte both ways untouched. It holds no key:
// TLS ends in the database, which has the certificate for its public name.
// Each connection, and each refusal, is a line of its output naming the
// client's address.
//
// The Relay runs one per public database, from its own image, on the
// database's private network and a network of its own that publishes the
// port. It reaches the database by its name there for every connection, so
// it carries on while the database is deployed again.
package main

import (
	"encoding/binary"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/signal"
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
	maxConnections := flag.Int("max-connections", 512, "connections open at once")
	handshake := flag.Duration("handshake-timeout", 10*time.Second, "how long a client has to ask for TLS")
	flag.Parse()

	logger := log.New(os.Stdout, "", 0)
	if *listen == "" || *target == "" || *maxConnections < 1 {
		logger.Fatal("kiln-database-gate needs -listen, -target and a positive -max-connections")
	}
	gate, err := newGate(*protocol, *target, *maxConnections, *handshake, logger)
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
	handshake func(client net.Conn) (net.Conn, error)
	target    string
	timeout   time.Duration
	slots     chan struct{}
	logger    *log.Logger
}

func newGate(protocol, target string, maxConnections int, timeout time.Duration, logger *log.Logger) (*gate, error) {
	g := &gate{
		target:  target,
		timeout: timeout,
		slots:   make(chan struct{}, maxConnections),
		logger:  logger,
	}
	switch protocol {
	case protocolPostgres:
		g.handshake = g.postgres
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
	upstream, err := g.handshake(client)
	if err != nil {
		var refused refusal
		if errors.As(err, &refused) {
			g.say("refused %s: %s", from, refused)
		} else {
			g.say("dropped %s: %v", from, err)
		}
		return
	}
	defer upstream.Close()
	client.SetDeadline(time.Time{})
	upstream.SetDeadline(time.Time{})
	g.say("connected %s", from)
	opened := time.Now()
	pipe(client, upstream)
	g.say("closed %s after %s", from, time.Since(opened).Round(time.Second))
}

// dial reaches the database by its name, looked up again for each
// connection, by the end of the client's handshake.
func (g *gate) dial(client net.Conn) (net.Conn, error) {
	deadline := time.Now().Add(g.timeout)
	upstream, err := (&net.Dialer{Deadline: deadline}).Dial("tcp", g.target)
	if err != nil {
		return nil, fmt.Errorf("the database can't be reached: %w", err)
	}
	upstream.SetDeadline(deadline)
	return upstream, nil
}

// forward reaches the database and sends it what the client sent so far.
func (g *gate) forward(client net.Conn, sent ...[]byte) (net.Conn, error) {
	upstream, err := g.dial(client)
	if err != nil {
		return nil, err
	}
	for _, bytes := range sent {
		if _, err := upstream.Write(bytes); err != nil {
			upstream.Close()
			return nil, err
		}
	}
	return upstream, nil
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

func (g *gate) postgres(client net.Conn) (net.Conn, error) {
	head := make([]byte, 8)
	if _, err := io.ReadFull(client, head); err != nil {
		return nil, err
	}
	// Postgres 17's clients can start TLS at once (sslnegotiation=direct).
	if isTLSRecord(head) {
		return g.forward(client, head)
	}
	length := binary.BigEndian.Uint32(head[0:4])
	code := binary.BigEndian.Uint32(head[4:8])
	// GSSAPI encryption isn't offered; a client then asks for TLS.
	if length == 8 && code == postgresGSSRequest {
		if _, err := client.Write([]byte{'N'}); err != nil {
			return nil, err
		}
		if _, err := io.ReadFull(client, head); err != nil {
			return nil, err
		}
		length = binary.BigEndian.Uint32(head[0:4])
		code = binary.BigEndian.Uint32(head[4:8])
	}
	switch {
	case length == 8 && code == postgresSSLRequest:
		upstream, err := g.forward(client, head)
		if err != nil {
			// Said in the clear: the client hasn't started TLS yet.
			client.Write(postgresError(unreachableMessage))
			return nil, err
		}
		answer := make([]byte, 1)
		if _, err := io.ReadFull(upstream, answer); err != nil {
			upstream.Close()
			return nil, err
		}
		if answer[0] != 'S' {
			upstream.Close()
			client.Write(postgresError("This database isn't ready for TLS"))
			return nil, refusal("the database didn't offer TLS")
		}
		if _, err := client.Write(answer); err != nil {
			upstream.Close()
			return nil, err
		}
		first, err := expectTLS(client)
		if err == nil {
			_, err = upstream.Write(first)
		}
		if err != nil {
			upstream.Close()
			return nil, err
		}
		return upstream, nil
	case code == postgresCancelRequest:
		// It names the session to cancel in the clear; Postgres 17's clients
		// send it over TLS.
		return nil, refusal("a cancel request without TLS")
	default:
		client.Write(postgresError(refusedMessage))
		return nil, refusal("no TLS")
	}
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
// database.
func (g *gate) mysql(client net.Conn) (net.Conn, error) {
	upstream, err := g.dial(client)
	if err != nil {
		// In place of the greeting, as MySQL sends one when it can't serve.
		client.Write(mysqlError(0, unreachableMessage))
		return nil, err
	}
	refuse := func(reason error) (net.Conn, error) {
		upstream.Close()
		return nil, reason
	}
	greeting, err := readMySQLPacket(upstream, mysqlMaxGreeting)
	if err != nil {
		return refuse(err)
	}
	if _, err := client.Write(greeting); err != nil {
		return refuse(err)
	}
	// The database turned it away itself, as when it has too many
	// connections; the client has its reason.
	if greeting[4] == 0xff {
		return refuse(refusal("the database refused it"))
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
	first, err := expectTLS(client)
	if err != nil {
		return refuse(err)
	}
	for _, bytes := range [][]byte{header, request, first} {
		if _, err := upstream.Write(bytes); err != nil {
			return refuse(err)
		}
	}
	return upstream, nil
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

// Redis and Valkey, on their TLS port: the client starts TLS at once.
func (g *gate) tls(client net.Conn) (net.Conn, error) {
	head := make([]byte, 3)
	if _, err := io.ReadFull(client, head); err != nil {
		return nil, err
	}
	if !isTLSRecord(head) {
		// A Redis client sends its password first; the error at least
		// says why it went nowhere.
		client.Write([]byte("-ERR " + refusedMessage + "\r\n"))
		return nil, refusal("no TLS")
	}
	return g.forward(client, head)
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
