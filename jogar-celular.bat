@echo off
echo 🐧 Iniciando Expo Mobile (QR Code)...
cd %~dp0\mobile
call npx expo start -c
if %errorlevel% neq 0 (
    echo.
    echo ❌ ERRO: O Expo falhou ao iniciar.
    pause
)
pause
