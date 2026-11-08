@echo off
setlocal DisableDelayedExpansion
"%~dp0nessie-executor-native.exe" managed-runtime -- %*
exit /b %errorlevel%
