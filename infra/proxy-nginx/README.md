# Proxy NGINX (Blue/Green)

This folder holds the proxy configuration used for Blue/Green deployments.

- `blue.conf` and `green.conf` define upstreams to the Blue or Green App VMs.
- `active.conf` is included by your main server block and **should contain the contents** of either `blue.conf` or `green.conf`.
  - To flip, overwrite `active.conf` with the content of the other file and then: `sudo systemctl reload nginx`.

> If your proxy host supports symlinks, you may instead symlink `active.conf` -> `blue.conf` or `green.conf`.
