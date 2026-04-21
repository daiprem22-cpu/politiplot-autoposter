#!/bin/bash
echo ""
echo " =========================================="
echo "  PolitiPlot Auto-Poster — Mac/Linux Setup"
echo " =========================================="
echo ""

# Check Node.js
if ! command -v node &> /dev/null; then
    echo "[ERROR] Node.js nuk është instaluar!"
    echo ""
    echo "Instalo me:"
    echo "  Mac:   brew install node"
    echo "  Linux: sudo apt install nodejs npm"
    echo ""
    exit 1
fi

echo "[OK] Node.js: $(node -v)"

# Install dependencies
echo ""
echo "[1/3] Duke instaluar varësitë..."
npm install
if [ $? -ne 0 ]; then
    echo "[ERROR] npm install dështoi."
    exit 1
fi
echo "[OK] Varësitë u instaluan."

# Create .env if missing
if [ ! -f ".env" ]; then
    echo ""
    echo "[2/3] Duke krijuar .env..."
    cp .env.example .env
    echo "[OK] .env u krijua."
    echo ""
    echo " ============================================================"
    echo "  HAPI TJETËR: Hap skedarin .env dhe plotëso:"
    echo "  1. ANTHROPIC_API_KEY  → console.anthropic.com"
    echo "  2. WP_URL             → https://politiplot.com"
    echo "  3. WP_USER            → username i WordPress"
    echo "  4. WP_APP_PASS        → Application Password"
    echo " ============================================================"
    echo ""
    echo "Hap me: nano .env  ose  code .env"
else
    echo "[OK] .env ekziston."
fi

echo ""
echo "[3/3] Setup i plotë!"
echo ""
echo "Per të nisur: npm start"
echo ""
