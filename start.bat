@echo off
echo.
echo  ================================
echo   PolitiPlot Auto-Poster - START
echo  ================================
echo.

if not exist ".env" (
    echo [ERROR] Skedari .env nuk u gjet!
    echo Nis fillimisht: setup.bat
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo [ERROR] node_modules nuk u gjet!
    echo Nis fillimisht: setup.bat
    pause
    exit /b 1
)

echo Sistemi po niset... (mos mbyll këtë dritare!)
echo Per ta ndalur: CTRL + C
echo.
node autoposter.js
pause
