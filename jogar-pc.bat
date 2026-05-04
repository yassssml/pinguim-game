@echo off
echo 🐧 Iniciando Servidor do Penguin Knockout (Porta 3001)...
cd %~dp0
node server.js
if %errorlevel% neq 0 (
    echo.
    echo ❌ ERRO: O servidor falhou ao iniciar. 
    echo Verifique se o Node.js esta instalado ou se a porta 3001 ja esta em uso.
    pause
)
pause
