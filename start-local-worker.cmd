@echo off
setlocal
cd /d "%~dp0"

if not exist ".env.local-worker" (
  copy /y ".env.local-worker.example" ".env.local-worker" >nul
  echo Створено файл .env.local-worker.
  echo Заповни VEIL_API_URL, LOCAL_WORKER_SECRET та OPENAI_API_KEY, а потім запусти цей файл знову.
  start "" notepad ".env.local-worker"
  pause
  exit /b 1
)

echo Запускаємо локальну монтажну станцію Veil of Ages...
call npm run worker:local
echo.
echo Монтажна станція зупинилася. Повідомлення вище підкаже причину.
pause
