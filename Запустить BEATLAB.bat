@echo off
chcp 65001 >nul
title BEATLAB
cd /d "%~dp0beatmaker"
echo Запускаю сервер BEATLAB...
start "BEATLAB сервер" /min node serve.js
timeout /t 2 /nobreak >nul
echo.
echo Сейчас появится ссылка вида https://....lhr.life - её и кидай друзьям.
echo Сам можешь играть по ней же или на http://localhost:5173
echo Не закрывай это окно, пока играете. Ссылка новая при каждом запуске.
echo.
"%SystemRoot%\System32\OpenSSH\ssh.exe" -o StrictHostKeyChecking=accept-new -o ServerAliveInterval=30 -R 80:localhost:5173 nokey@localhost.run
echo.
echo Туннель закрылся. Запусти этот файл ещё раз, чтобы получить новую ссылку.
pause
