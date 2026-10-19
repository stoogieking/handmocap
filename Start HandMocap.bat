@echo off
rem Starts the HandMocap local server and opens it in your default browser.
rem Close the window that opens to stop it. Nothing is installed or changed on this computer.
title HandMocap server
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\serve.ps1"
if errorlevel 1 pause
