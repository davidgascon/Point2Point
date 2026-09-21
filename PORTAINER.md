# Deploying with Portainer

## Use "Repository", not "Web editor"

This is the important part. Pasting the compose file into Portainer's web
editor will not work, and the errors it gives are misleading.

The stack builds three images from Dockerfiles that live next to the compose
file. A pasted compose file has no surrounding folder, so the build fails.

**Stacks → Add stack → Repository:**

| Field | Value |
|---|---|
| Name | `point2point` |
| Build method | **Repository** |
| Repository URL | your GitHub URL |
| Repository reference | `refs/heads/main` |
| Compose path | `docker-compose.yml` |
| Authentication | on, if the repo is private — use a PAT |

Then add environment variables in the stack's env section:

```
APP_PORT=8080
PUBLIC_URL=https://checkout.yourdomain.com
PB_VERSION=0.29.3
```

Portainer clones the repo, so the Dockerfiles and the `web/` folder are all
there and the relative paths work.

## If you hit: "not a directory" on a config file

```
error mounting "/data/compose/23/nginx/default.conf" ... not a directory
```

This was a bind mount whose source did not exist. When that happens Docker
creates an empty **directory** at the source path, then fails because the
destination is a file. Worse, the bogus directory stays behind and every
redeploy fails the same way even after the real file appears.

The stack no longer uses bind mounts at all — the nginx config, the app and
the migrations are baked into the images. Pull the latest compose file, then
clear the leftover on the Docker host:

```bash
sudo rm -rf /data/compose/23/nginx
```

(`23` is the stack id in your error; check the path in yours.) Then redeploy.

## About the earlier volume error

```
service "pocketbase" refers to undefined volume point2point/pb_data
```

`point2point` is your stack name; Portainer prefixes volumes with it. The
message means it could not find the top-level `volumes:` declaration.

Two causes, and it is worth knowing which you had:

1. **The paste was cut short.** The `volumes:` block sits at the very bottom
   of the file, after the commented-out networks section. It is easy to miss
   the tail when copying.
2. **Null-valued volume entries.** The file declared them as `pb_data:` with
   nothing after it, which is valid compose but some Portainer versions do not
   resolve. They are now declared with an explicit `driver: local`, which
   every version accepts.

Pull the latest file either way.

## After the stack is up

Portainer will not run `setup.sh` for you, so do those steps by hand:

```bash
# on the Docker host
docker compose -p point2point exec pocketbase \
  /pb/pocketbase superuser upsert you@company.com yourpassword
```

Or just open `https://checkout.yourdomain.com/_/` and create the superuser in
the browser on first visit — same result.

Then:

1. Dashboard → Settings → Mail → SMTP → send a test
2. Dashboard → `users` → add your team, unique initials
3. Upload each project's source workbook to the exporter
4. Phones: Safari → Share → Add to Home Screen

## Updating

Push to GitHub, then in Portainer: the stack → **Pull and redeploy**.

One catch: phones cache the app in a service worker. Bump the cache name in
`web/sw.js` before you push, or they keep running the old build:

```bash
sed -i "s/fc-shell-v[0-9]*/fc-shell-v$(date +%s)/" web/sw.js
```

## Checking it works

From the Docker host:

```bash
curl -s http://localhost:8080/api/health      # {"code":200,...}
curl -s http://localhost:8080/export/health   # {"ok":true,...}
curl -sI http://localhost:8080/ | head -1     # 200
```

If those pass but the public URL does not, the problem is in Nginx Proxy
Manager, not this stack.
