# The app and its routing config are baked in rather than bind-mounted.
# Bind mounts are fragile under stack managers: a missing source path gets
# silently created as a directory, and the container then fails to start.
FROM nginx:1.27-alpine

COPY nginx/default.conf /etc/nginx/conf.d/default.conf
COPY web/ /srv/

# No `nginx -t` here on purpose. It resolves upstream hostnames, and the
# other containers do not exist during a build. The config uses Docker's
# resolver at request time instead, so syntax errors surface in the
# container log at start rather than breaking the build.

EXPOSE 8080
