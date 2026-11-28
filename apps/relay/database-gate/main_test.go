package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"encoding/pem"
	"io"
	"log"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// A certificate for some names, as PEM, chain then key, the way the Relay
// writes each one, and a pool that trusts it.
type issued struct {
	pem   []byte
	trust *x509.CertPool
}

func issue(t *testing.T, names ...string) issued {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	template := &x509.Certificate{
		DNSNames:     names,
		NotAfter:     time.Now().Add(time.Hour),
		NotBefore:    time.Now().Add(-time.Hour),
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: names[0]},
	}
	der, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	encodedKey, err := x509.MarshalPKCS8PrivateKey(key)
	if err != nil {
		t.Fatal(err)
	}
	leaf, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	trust := x509.NewCertPool()
	trust.AddCert(leaf)
	return issued{
		pem: append(
			pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}),
			pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: encodedKey})...,
		),
		trust: trust,
	}
}

func writeCertificates(t *testing.T, path string, held ...issued) {
	t.Helper()
	var file []byte
	for _, one := range held {
		file = append(file, one.pem...)
	}
	if err := os.WriteFile(path, file, 0o600); err != nil {
		t.Fatal(err)
	}
}

// A gate in front of a fake database, which records what reaches it and
// answers as the test says.
type harness struct {
	certificates string
	gate         string
	output       *output
	upstream     chan net.Conn
}

func start(t *testing.T, protocol string, maxConnections int, timeout time.Duration, held ...issued) *harness {
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
	path := filepath.Join(t.TempDir(), "certificates.pem")
	if len(held) == 0 {
		held = []issued{issue(t, "db.example.com")}
	}
	writeCertificates(t, path, held...)
	said := &output{}
	g, err := newGate(protocol, database.Addr().String(), path, maxConnections, timeout, log.New(said, "", 0))
	if err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { listener.Close() })
	go g.serve(listener)
	return &harness{certificates: path, gate: listener.Addr().String(), output: said, upstream: accepted}
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

// secure starts the client's TLS with the gate, checking its certificate
// for `name` against `trust`; an empty name sends none.
func secure(t *testing.T, connection net.Conn, name string, trust *x509.CertPool, protocols ...string) *tls.Conn {
	t.Helper()
	config := &tls.Config{NextProtos: protocols, RootCAs: trust, ServerName: name}
	if name == "" {
		// Checked by hand below: Go sends the name it checks.
		config.InsecureSkipVerify = true
	}
	client := tls.Client(connection, config)
	if err := client.Handshake(); err != nil {
		t.Fatalf("TLS with the gate: %v", err)
	}
	return client
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

func TestPostgresEndsTLSAndPassesTheStartupOnInTheClear(t *testing.T) {
	certificate := issue(t, "db.example.com")
	h := start(t, protocolPostgres, 8, 5*time.Second, certificate)
	client := h.connect(t)
	write(t, client, postgresMessage(postgresSSLRequest))
	if got := read(t, client, 1); got[0] != 'S' {
		t.Fatalf("the client got %q", got)
	}
	secured := secure(t, client, "db.example.com", certificate.trust, "postgresql")
	write(t, secured, postgresStartup())
	database := h.database(t)
	if got := read(t, database, len(postgresStartup())); !bytes.Equal(got, postgresStartup()) {
		t.Fatalf("the database got %x", got)
	}
	write(t, database, []byte("R\x00\x00\x00\x08\x00\x00\x00\x00"))
	if got := read(t, secured, 9); got[0] != 'R' {
		t.Fatalf("the client got %q", got)
	}
	eventually(t, func() bool {
		return strings.Contains(h.output.String(), "connected 127.0.0.1 to db.example.com")
	})
}

func TestGivesEachNameItsOwnCertificate(t *testing.T) {
	first := issue(t, "db.example.com")
	second := issue(t, "orders.example.net")
	h := start(t, protocolTLS, 8, 5*time.Second, first, second)

	named := secure(t, h.connect(t), "orders.example.net", second.trust)
	if got := named.ConnectionState().PeerCertificates[0].DNSNames; got[0] != "orders.example.net" {
		t.Fatalf("the client got %v", got)
	}
	// A client that names none gets the first name's.
	unnamed := secure(t, h.connect(t), "", nil)
	if got := unnamed.ConnectionState().PeerCertificates[0].DNSNames; got[0] != "db.example.com" {
		t.Fatalf("the client got %v", got)
	}
}

func TestReadsItsCertificatesAgainWhenTheyChange(t *testing.T) {
	before := issue(t, "db.example.com")
	h := start(t, protocolTLS, 8, 5*time.Second, before)
	secure(t, h.connect(t), "db.example.com", before.trust)

	// Caught partway through being written, the last good ones serve.
	if err := os.WriteFile(h.certificates, before.pem[:len(before.pem)/2], 0o600); err != nil {
		t.Fatal(err)
	}
	secure(t, h.connect(t), "db.example.com", before.trust)

	renewed := issue(t, "db.example.com")
	writeCertificates(t, h.certificates, renewed)
	// A file's time can be coarse; its size differs too, but not always.
	future := time.Now().Add(time.Minute)
	os.Chtimes(h.certificates, future, future)
	secure(t, h.connect(t), "db.example.com", renewed.trust)
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
	certificate := issue(t, "db.example.com")
	h := start(t, protocolPostgres, 8, 5*time.Second, certificate)
	client := h.connect(t)
	write(t, client, postgresMessage(postgresGSSRequest))
	if got := read(t, client, 1); got[0] != 'N' {
		t.Fatalf("the client got %q", got)
	}
	write(t, client, postgresMessage(postgresSSLRequest))
	if got := read(t, client, 1); got[0] != 'S' {
		t.Fatalf("the client got %q", got)
	}
	secure(t, client, "db.example.com", certificate.trust)
}

func TestPostgresTakesDirectTLS(t *testing.T) {
	certificate := issue(t, "db.example.com")
	h := start(t, protocolPostgres, 8, 5*time.Second, certificate)
	secured := secure(t, h.connect(t), "db.example.com", certificate.trust, "postgresql")
	if got := secured.ConnectionState().NegotiatedProtocol; got != "postgresql" {
		t.Fatalf("it agreed on %q", got)
	}
	write(t, secured, postgresStartup())
	database := h.database(t)
	if got := read(t, database, len(postgresStartup())); !bytes.Equal(got, postgresStartup()) {
		t.Fatalf("the database got %x", got)
	}
}

func TestPostgresRefusesPlainBytesAfterAgreeingToTLS(t *testing.T) {
	h := start(t, protocolPostgres, 8, 5*time.Second)
	client := h.connect(t)
	write(t, client, postgresMessage(postgresSSLRequest))
	read(t, client, 1)
	write(t, client, postgresStartup())
	closed(t, client)
	database := h.database(t)
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

// A server's greeting: its version, connection ID, the first part of its
// challenge, then its capabilities.
func mysqlGreeting(capabilities uint16) []byte {
	payload := []byte("\x0a8.4.13\x00\x01\x00\x00\x00challeng\x00")
	payload = binary.LittleEndian.AppendUint16(payload, capabilities)
	payload = append(payload, "\xff\x02\x00\xff\xc3rest"...)
	return mysqlPacket(0, payload)
}

func mysqlLogin(capabilities uint32, length int) []byte {
	payload := make([]byte, length)
	binary.LittleEndian.PutUint32(payload[0:4], capabilities)
	return mysqlPacket(1, payload)
}

func TestMySQLEndsTLSAndStartsItsOwnToTheDatabase(t *testing.T) {
	certificate := issue(t, "db.example.com")
	h := start(t, protocolMySQL, 8, 5*time.Second, certificate)
	client := h.connect(t)
	database := h.database(t)
	greeting := mysqlGreeting(0xffff)
	write(t, database, greeting)
	if got := read(t, client, len(greeting)); !bytes.Equal(got, greeting) {
		t.Fatalf("the client got %q", got)
	}
	request := mysqlLogin(0x000aa200|mysqlClientSSL, mysqlSSLRequestBytes)
	write(t, client, request)
	secured := make(chan *tls.Conn, 1)
	go func() { secured <- secure(t, client, "db.example.com", certificate.trust) }()

	// The database is asked for TLS in the client's words, then starts it
	// with its own certificate, whatever its name.
	if got := read(t, database, len(request)); !bytes.Equal(got, request) {
		t.Fatalf("the database got %x", got)
	}
	own := issue(t, "database-1234")
	ownCertificate, err := tls.X509KeyPair(own.pem, own.pem)
	if err != nil {
		t.Fatal(err)
	}
	server := tls.Server(database, &tls.Config{Certificates: []tls.Certificate{ownCertificate}})
	if err := server.Handshake(); err != nil {
		t.Fatalf("TLS with the database: %v", err)
	}
	front := <-secured
	login := mysqlPacket(2, []byte("login: kiln and its scrambled password"))
	write(t, front, login)
	if got := read(t, server, len(login)); !bytes.Equal(got, login) {
		t.Fatalf("the database got %q", got)
	}
	write(t, server, mysqlPacket(3, []byte{0, 0, 0, 2, 0}))
	if got := read(t, front, 9); got[3] != 3 || got[4] != 0 {
		t.Fatalf("the client got %x", got)
	}
}

func TestMySQLRefusesAPlainLogin(t *testing.T) {
	h := start(t, protocolMySQL, 8, 5*time.Second)
	client := h.connect(t)
	database := h.database(t)
	greeting := mysqlGreeting(0xffff)
	write(t, database, greeting)
	read(t, client, len(greeting))
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
	greeting := mysqlGreeting(0xffff)
	write(t, database, greeting)
	read(t, client, len(greeting))
	write(t, client, mysqlLogin(0x000aa200, mysqlSSLRequestBytes))
	answer := closed(t, client)
	if len(answer) < 5 || answer[4] != 0xff {
		t.Fatalf("the client got %x", answer)
	}
	if rest := closed(t, database); len(rest) != 0 {
		t.Fatalf("the database got %q", rest)
	}
}

func TestMySQLSaysWhenTheDatabaseHasNoTLS(t *testing.T) {
	h := start(t, protocolMySQL, 8, 5*time.Second)
	client := h.connect(t)
	database := h.database(t)
	write(t, database, mysqlGreeting(0xffff&^mysqlClientSSL))
	answer := closed(t, client)
	if len(answer) < 5 || answer[4] != 0xff || !bytes.Contains(answer, []byte("isn't ready for TLS")) {
		t.Fatalf("the client got %q", answer)
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

func TestTLSPortEndsTLSAndPassesCommandsOnInTheClear(t *testing.T) {
	certificate := issue(t, "db.example.com")
	h := start(t, protocolTLS, 8, 5*time.Second, certificate)
	secured := secure(t, h.connect(t), "db.example.com", certificate.trust)
	write(t, secured, []byte("AUTH kiln secret\r\n"))
	database := h.database(t)
	if got := read(t, database, 18); string(got) != "AUTH kiln secret\r\n" {
		t.Fatalf("the database got %q", got)
	}
	// Each side's end of sending reaches the other, and the gate is done
	// once both have ended.
	database.Close()
	closed(t, secured)
	secured.Close()
	eventually(t, func() bool { return strings.Contains(h.output.String(), "closed 127.0.0.1") })
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
	certificate := issue(t, "db.example.com")
	h := start(t, protocolTLS, 1, 5*time.Second, certificate)
	secure(t, h.connect(t), "db.example.com", certificate.trust)
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
			path := filepath.Join(t.TempDir(), "certificates.pem")
			writeCertificates(t, path, issue(t, "db.example.com"))
			g, err := newGate(protocol, target, path, 8, 2*time.Second, log.New(io.Discard, "", 0))
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
	if _, err := newGate("http", "127.0.0.1:1", "certificates.pem", 1, time.Second, log.New(io.Discard, "", 0)); err == nil {
		t.Fatal("the gate took an unknown protocol")
	}
}
