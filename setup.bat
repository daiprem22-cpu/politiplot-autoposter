@echo off
echo.
echo  ==========================================
echo   PolitiPlot Auto-Poster — Windows Setup
echo  ==========================================
echo.

:: Check Node.js
node -v >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Node.js nuk eshte instaluar!
    echo.
    echo Shko tek: https://nodejs.org
    echo Shkarko LTS dhe instalo, pastaj nis kete skedar perseri.
    echo.
    pause
    exit /b 1
)

echo [OK] Node.js i gjetur: 
node -v

:: Install dependencies
echo.
echo [1/3] Duke instaluar varësitë (npm install)...
npm install
if %errorlevel% neq 0 (
    echo [ERROR] npm install deshtoi. Kontrollo lidhjen me internet.
    pause
    exit /b 1
)
echo [OK] Varësitë u instaluan.

:: Check .env
if not exist ".env" (
    echo.
    echo [2/3] Duke krijuar skedarin .env...
    copy .env.example .env
    echo [OK] Skedari .env u krijua.
    echo.
    echo  ============================================================
    echo   TANI DUHET TE HAPESH SKEDARIN .env DHE TE VENDOSESH:
    echo   1. ANTHROPIC_API_KEY  (nga console.anthropic.com)
    echo   2. WP_URL             (https://politiplot.com)
    echo   3. WP_USER            (username i WordPress)
    echo   4. WP_APP_PASS        (Application Password nga WordPress)
    echo  ============================================================
    echo.
    echo Duke hapur .env per editim...
    notepad .env
) else (
    echo [OK] Skedari .env ekziston.
)

echo.
echo [3/3] Gati per nisje!
echo.
echo Per te nisur sistemin, ekzekuto:
echo   npm start
echo.
echo Ose klikoni 2x mbi skedarin: start.bat
echo.
pause
