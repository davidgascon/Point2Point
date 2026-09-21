# Running it from GitHub

## Make the repo private

The app build in `web/index.html` carries a real customer's point list —
KOKUSAI, 456 points, controller names and all. That is client data. **Private
repo**, or strip the sample project out before the first commit.

`.gitignore` already blocks `.env`, `pb_data/`, `backups/`, `templates/` and
any `.xlsm`. Check before you push:

```bash
git status --porcelain      # .env must not appear
git check-ignore -v .env    # should print the matching rule
```

## First push

```bash
cd deploy
git init -b main
git add .
git commit -m "Field Checkout deployment stack"
gh repo create field-checkout --private --source=. --push
# or, without the gh CLI:
#   git remote add origin git@github.com:you/field-checkout.git
#   git push -u origin main
```

## Give the VM read-only access

A deploy key is a read-only SSH key scoped to this one repo — better than
putting your own credentials on a server.

```bash
# on the VM
ssh-keygen -t ed25519 -f ~/.ssh/field-checkout -N "" -C "field-checkout deploy"
cat ~/.ssh/field-checkout.pub
```

Paste that into GitHub → the repo → Settings → Deploy keys → Add, leaving
"Allow write access" **off**. Then on the VM:

```bash
cat >> ~/.ssh/config <<'CFG'
Host github-field-checkout
  HostName github.com
  User git
  IdentityFile ~/.ssh/field-checkout
  IdentitiesOnly yes
CFG
chmod 600 ~/.ssh/config
```

## Deploy

```bash
sudo mkdir -p /opt/field-checkout && sudo chown $USER /opt/field-checkout
git clone github-field-checkout:you/field-checkout.git /opt/field-checkout
cd /opt/field-checkout
./setup.sh
```

`.env` is created on the VM by `setup.sh` and stays there. It is never in git,
so each machine keeps its own domain and settings.

## Shipping a change

On your laptop:

```bash
cp ~/Downloads/field_checkout.html web/index.html
git commit -am "New verify screen"
git push
```

On the VM:

```bash
cd /opt/field-checkout && make deploy
```

`make deploy` pulls, bumps the service worker cache so phones stop serving the
old app, rebuilds and health-checks. Phones pick it up the next time they open
with signal.

## Rolling back

```bash
git log --oneline -10
git checkout <sha> -- web/index.html
make deploy
```

Or the whole stack: `git revert <sha> && make deploy`.

**Data is not in git.** A rollback changes the app, never the database. Take a
`make backup` before anything structural.

## Auto-deploy on push, if you want it

A webhook or an Action that SSHes in and runs `make deploy` is straightforward,
but think about whether you want a push to main to reach production while a
tech is mid-checkout on a roof. A manual `make deploy` at the end of the day
is usually the right speed for this.
