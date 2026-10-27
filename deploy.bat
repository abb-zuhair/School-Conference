@echo off
setlocal
title ACA Appointments - deploy

rem ---------------------------------------------------------------------
rem  Double-click this file to put the update live.
rem
rem  It unpacks the update zip into a fresh folder and pushes it to GitHub,
rem  which makes Railway rebuild the site. It does not touch your old
rem  project folder, and it does not touch the live database - that lives
rem  on the Railway volume and a deploy does not go near it.
rem
rem  If your zip is somewhere other than Downloads, drag the zip onto this
rem  file instead of double-clicking it.
rem
rem  Keep this file plain ASCII.
rem ---------------------------------------------------------------------

rem Windows adds _1, _2 and so on when a download lands on an existing name,
rem so take the newest School-Conference zip rather than a fixed filename.
set "ZIP="
if not "%~1"=="" set "ZIP=%~1"
if "%ZIP%"=="" (
  for /f "delims=" %%F in ('dir /b /o-d "%USERPROFILE%\Downloads\School-Conference*.zip" 2^>nul') do (
    if not defined ZIP set "ZIP=%USERPROFILE%\Downloads\%%F"
  )
)
if "%ZIP%"=="" set "ZIP=%USERPROFILE%\Downloads\School-Conference.zip"

set "WORK=%USERPROFILE%\Downloads\School-Conference-deploy"
set "REPO=%WORK%\aca-appointments"
set "SITE=https://appointments.aca.edu.kw"

echo.
echo   ACA Appointments - deploy
echo   =========================
echo.

rem --- Is the zip there? ------------------------------------------------
if not exist "%ZIP%" (
  echo   Could not find the update zip at:
  echo      %ZIP%
  echo.
  echo   Drag the zip file onto this .bat file instead of double-clicking,
  echo   and it will use that one.
  goto :fail
)
echo   Update zip : %ZIP%

rem --- Is git installed? ------------------------------------------------
where git >nul 2>&1
if errorlevel 1 (
  echo.
  echo   git is not installed, or is not on PATH.
  echo   Install "Git for Windows", then run this again.
  goto :fail
)

rem --- Step 1: back up the live database --------------------------------
echo.
echo   Step 1 of 4 - back up the live database
echo.
echo   Opening the backup download in your browser. Sign in as admin if it
echo   asks, and save the file somewhere safe. This is your undo button.
echo.
start "" "%SITE%/admin/backup.db"
echo   When the file has downloaded, press a key to carry on.
echo   (Close this window instead if you want to stop - nothing has changed yet.)
echo.
pause

rem --- Step 2: unpack ---------------------------------------------------
echo.
echo   Step 2 of 4 - unpacking the update
if exist "%WORK%" rmdir /s /q "%WORK%"
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Expand-Archive -LiteralPath '%ZIP%' -DestinationPath '%WORK%' -Force; exit 0 } catch { Write-Host $_.Exception.Message; exit 1 }"
if errorlevel 1 (
  echo.
  echo   Could not unpack the zip. Is the download complete?
  goto :fail
)
if not exist "%REPO%\.git" (
  echo.
  echo   The unpacked folder has no git repository inside it.
  echo   Paste this message into the chat and Claude will sort it out.
  goto :fail
)
echo   Unpacked to %REPO%

rem --- Step 3: show what is about to go ---------------------------------
echo.
echo   Step 3 of 4 - what is about to be sent to GitHub
echo.
pushd "%REPO%"
git log --oneline -7
if errorlevel 1 (
  echo.
  echo   Could not read the repository.
  popd
  goto :fail
)

rem --- Step 4: push -----------------------------------------------------
echo.
echo   Step 4 of 4 - pushing to GitHub
echo.
git push origin main
if errorlevel 1 (
  echo.
  echo   The push did not work. Copy everything above into the chat.
  popd
  goto :fail
)
popd

echo.
echo   ====================================================
echo    Pushed. Railway is rebuilding - give it a minute.
echo.
echo    Then open the site and check:
echo      1. Your bookings and staff are all still there.
echo      2. No red storage warning on the admin dashboard.
echo      3. Admin, Staff - "Department head" is in the role list.
echo   ====================================================
echo.
pause
exit /b 0

:fail
echo.
echo   Nothing was sent. Your site is unchanged.
echo.
pause
exit /b 1
