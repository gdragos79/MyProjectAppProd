HOW THE BLUE/GREEN SWITCH WORKS (Proxy VM)
=========================================

Files:
  /etc/nginx/sites-enabled/myapp.conf      -> Site config that 'includes' /etc/nginx/upstreams/active.conf
  /etc/nginx/upstreams/blue.conf           -> defines upstream to BLUE app VM (replace APP_BLUE_IP with the VM IP)
  /etc/nginx/upstreams/green.conf          -> defines upstream to GREEN app VM (replace APP_GREEN_IP with the VM IP)
  /etc/nginx/upstreams/active.conf         -> symlink pointing to either blue.conf or green.conf

Switch steps (manual):
  sudo ln -sfn /etc/nginx/upstreams/blue.conf /etc/nginx/upstreams/active.conf
  sudo nginx -t && sudo systemctl reload nginx

In our GitHub Actions deploy workflow, this switch is done automatically when you pass switch_traffic=true.
