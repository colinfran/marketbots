#!/bin/sh
# Installs the host agent on Linux (docs/SERVER.md §11): sensor modules at boot, the udev rule that
# lets it set the fans, and its systemd unit. Run from the repo root after
# `pnpm install --frozen-lockfile && pnpm --filter @mb/host-agent build`. Asks for sudo.
set -eu
here=$(dirname "$0")
sudo install -m 644 "$here/marketbots-sensors.conf" /etc/modules-load.d/marketbots-sensors.conf
sudo modprobe coretemp; sudo modprobe nct6775
sudo install -m 644 "$here/60-marketbots-fans.rules" /etc/udev/rules.d/60-marketbots-fans.rules
sudo udevadm control --reload
sudo udevadm trigger --action=add --subsystem-match=hwmon
sudo install -m 644 "$here/marketbots-host-agent.service" /etc/systemd/system/marketbots-host-agent.service
sudo systemctl daemon-reload
sudo systemctl enable marketbots-host-agent
sudo systemctl restart marketbots-host-agent
systemctl --no-pager --lines=5 status marketbots-host-agent
