# Source this before any node/pnpm command: `. factory/env.sh`
# Non-interactive shells don't load nvm from .zshrc, so node and pnpm are missing.
export NVM_DIR="$HOME/.nvm"
for f in /opt/homebrew/opt/nvm/nvm.sh "$NVM_DIR/nvm.sh"; do
  if [ -s "$f" ]; then . "$f" --no-use; break; fi
done
nvm use 26 >/dev/null # SLICE_1_PLAN D2: Node 26
export PNPM_HOME="$HOME/Library/pnpm"
export PATH="$PNPM_HOME:$PATH"
