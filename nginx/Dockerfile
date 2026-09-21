# The app and its routing config are baked into the image rather than
# bind-mounted. Bind mounts are fragile under stack managers: if the source
# path is missing at start, Docker silently creates a *directory* there and
# the container then fails with "not a directory".
FROM nginx:1.27-alpine

COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY web/ /srv/

EXPOSE 8080
