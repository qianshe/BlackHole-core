package main

import "testing"

func TestManagedPortUses7306AndHonorsOnlyExplicitOverrides(t *testing.T) {
	for _, row := range []struct {
		name, env string
		arg, want int
		invalid   bool
	}{
		{"default", "", 0, 7306, false},
		{"same port explicit", "7306", 0, 7306, false},
		{"isolated environment", "51963", 0, 51963, false},
		{"explicit argument", "", 52171, 52171, false},
		{"argument precedence", "51963", 52171, 52171, false},
		{"not numeric", "oops", 0, 0, true},
		{"out of range", "65536", 0, 0, true},
		{"negative", "", -1, 0, true},
		{"zero environment", "0", 0, 0, true},
	} {
		t.Run(row.name, func(t *testing.T) {
			actual, err := configuredManagedPort(row.env, row.arg)
			if row.invalid {
				if err == nil {
					t.Fatal("invalid port accepted")
				}
				return
			}
			if err != nil || actual != row.want {
				t.Fatalf("got %d/%v want %d", actual, err, row.want)
			}
		})
	}
}
