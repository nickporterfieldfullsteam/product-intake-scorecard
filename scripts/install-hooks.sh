#!/bin/sh
# Install git hooks for the Arbiter repo.
# Run once after cloning: ./scripts/install-hooks.sh

HOOK=.git/hooks/pre-commit

cat > "$HOOK" << 'HOOKEOF'
#!/bin/sh
STAMP=$(TZ='America/New_York' date '+%Y-%m-%d %I:%M:%S %p EST')
sed -i '' "s/const BUILD_STAMP = '.*'/const BUILD_STAMP = '$STAMP'/" index.html
sed -i '' "s/const BUILD_STAMP = '.*'/const BUILD_STAMP = '$STAMP'/" portal/index.html
git add index.html portal/index.html
HOOKEOF

chmod +x "$HOOK"
echo "✓ Pre-commit hook installed at $HOOK"
