@echo off
rem 直接启动编译好的程序，绕过 npm（npm run 光自身开销就要 1.5 秒）。
rem 想更快就右键这个文件 → 发送到 → 桌面快捷方式，或把 exe 固定到任务栏。
start "" "%~dp0src-tauri\target\release\sylk.exe"
