package main

import (
	"io"
	"net"
)

const (
	guestEgressProxyAddress = "127.0.0.1:8137"
	guestEgressTunnelLimit  = 16
)

type guestEgressDialer func() (net.Conn, error)

// startGuestEgressProxy accepts guest-local clients only. Each accepted stream
// is first attached to the authenticated host virtio tunnel, then forwarded
// untouched. The host's owner-only CONNECT gateway remains the sole component
// that parses HTTP and is allowed to open a remote socket.
func startGuestEgressProxy(address, sessionToken string, dial guestEgressDialer) (net.Listener, error) {
	if !validBootstrapToken(sessionToken) || dial == nil {
		return nil, errInvalidFrame
	}
	listener, err := net.Listen("tcp4", address)
	if err != nil {
		return nil, err
	}
	slots := make(chan struct{}, guestEgressTunnelLimit)
	go acceptGuestEgressConnections(listener, sessionToken, dial, slots)
	return listener, nil
}

func acceptGuestEgressConnections(
	listener net.Listener,
	sessionToken string,
	dial guestEgressDialer,
	slots chan struct{},
) {
	for {
		client, err := listener.Accept()
		if err != nil {
			return
		}
		select {
		case slots <- struct{}{}:
			go func() {
				defer func() { <-slots }()
				proxyGuestEgressConnection(client, sessionToken, dial)
			}()
		default:
			_ = client.Close()
		}
	}
}

func proxyGuestEgressConnection(client net.Conn, sessionToken string, dial guestEgressDialer) {
	defer client.Close()
	tunnel, err := dial()
	if err != nil {
		return
	}
	defer tunnel.Close()
	if err := writeGuestEgressPrelude(tunnel, sessionToken); err != nil {
		return
	}
	clientDone := make(chan struct{})
	go func() {
		_, _ = io.Copy(tunnel, client)
		close(clientDone)
	}()
	_, _ = io.Copy(client, tunnel)
	<-clientDone
}
