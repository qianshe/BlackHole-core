package main

import (
	"errors"
	"strconv"
)

// All product channels use the one local service by default. No environment
// argument is accepted here: a cloud release channel cannot fork local state.
const defaultManagedPort = 7306

func configuredManagedPort(environmentValue string, argument int) (int, error) {
	port := defaultManagedPort
	if environmentValue != "" {
		value, err := strconv.Atoi(environmentValue)
		if err != nil {
			return 0, errors.New("port_invalid")
		}
		port = value
	}
	if argument != 0 {
		port = argument
	}
	if port < 1 || port > 65535 {
		return 0, errors.New("port_invalid")
	}
	return port, nil
}
