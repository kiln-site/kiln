// Command kiln-relay-healthcheck is the Relay image's Docker HEALTHCHECK.
//
// Docker runs it every interval, so it is a static binary instead of a Node.js
// process. It asks the Relay's loopback-only, plain-HTTP health listener for
// GET /health and exits 0 only on 204 No Content.
package main

import (
	"bufio"
	"fmt"
	"net"
	"os"
	"strings"
	"time"
)

func main() {
	if err := check(); err != nil {
		fmt.Fprintln(os.Stderr, "kiln-relay-healthcheck:", err)
		os.Exit(1)
	}
}

func check() error {
	port := os.Getenv("KILN_RELAY_HEALTH_PORT")
	if port == "" {
		port = "4101"
	}
	deadline := time.Now().Add(2500 * time.Millisecond)
	dialer := net.Dialer{Deadline: deadline}
	connection, err := dialer.Dial("tcp", net.JoinHostPort("127.0.0.1", port))
	if err != nil {
		return err
	}
	defer connection.Close()
	if err := connection.SetDeadline(deadline); err != nil {
		return err
	}
	request := "GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n"
	if _, err := connection.Write([]byte(request)); err != nil {
		return err
	}
	status, err := bufio.NewReader(connection).ReadString('\n')
	if err != nil {
		return err
	}
	if fields := strings.Fields(status); len(fields) < 2 || fields[1] != "204" {
		return fmt.Errorf("unexpected response %q", strings.TrimSpace(status))
	}
	return nil
}
