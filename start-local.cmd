@echo off
setlocal
cd /d "%~dp0"

echo Запускаємо локальну студію Veil of Ages...
call npm run local
echo.
echo Локальна студія зупинилася. Повідомлення вище підкаже причину.
pause
