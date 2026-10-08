# DaFit native BLE uploader (Android, no Chrome)

Small headless APK that runs the **exact** `moyoungBle.ts` wire sequence
(prep `0x74` → 244B chunks on `0xFEE6` → finish → optional `FACE_SET_XFER` →
apply `0x19 0x0d`) over the native Android BLE stack — with the same
10s-per-chunk timeout, ×3 retries, 60ms pacing, and raw-hex logging.

Purpose (issue #1, Icon Lite MOY-8Y82): find out whether `0xffff0000` and the
early-completion are real watch behaviour or Web Bluetooth quirks, using the
real negotiated MTU. The user only installs the APK once; everything else
runs from a Shizuku/`rish` shell.

## Build

Anywhere with Gradle + Android SDK (CI does it automatically):

```bash
cd android-uploader
gradle :app:assembleDebug
# → app/build/outputs/apk/debug/app-debug.apk
```

A `build-uploader-apk` GitHub Actions workflow builds this on every push to
the `android-uploader` branch and attaches `app-debug.apk` as an artifact.

Requirements: JDK 17, Android SDK (compileSdk 34, build-tools 34), no other
dependencies — pure framework BLE, zero libraries.

## Install + permissions (rish shell, no taps after install)

```sh
# 1. install (one user tap if done from UI, or headless via shell)
pm install -r /sdcard/Download/app-debug.apk

# 2. grant runtime permissions headlessly
pm grant com.dafit.uploader android.permission.BLUETOOTH_CONNECT
pm grant com.dafit.uploader android.permission.BLUETOOTH_SCAN
pm grant com.dafit.uploader android.permission.ACCESS_FINE_LOCATION
pm grant com.dafit.uploader android.permission.READ_EXTERNAL_STORAGE

# 3. sanity: watch must be BONDED (pair once via system settings or Da Fit,
#    then FORCE-STOP / disconnect the Da Fit app so it releases the link)
dumpsys bluetooth_manager | grep -i -A2 "icon lite"
```

## Run uploads

```sh
# transfer-config OFF (dawfu sequence, current default)
am start -n com.dafit.uploader/.UploadActivity \
  -e deviceName "Icon Lite" -e file /sdcard/test-face.bin --ez xfer false
sleep 60

# transfer-config ON (DaFup middle step fe ea 20 0a b4 11 30 04 00 00)
am start -n com.dafit.uploader/.UploadActivity \
  -e deviceName "Icon Lite" -e file /sdcard/test-face.bin --ez xfer true
sleep 60
```

## Read results

```sh
# full log with progress + RESULT line
cat /sdcard/Android/data/com.dafit.uploader/files/dafit-upload-result.txt
# or: cat /sdcard/Download/dafit-upload-result.txt   (best-effort mirror)
# live/raw: logcat -d -s DafitUpload
```

Report back on the issue: the `RESULT:` line (checksum, raw hex,
`chunks=A/B`, `xfer=`, any `ENDED_EARLY`/`FFFF0000` flags), plus whether a
new/blank face appeared on the watch.

## Test file

Place a known-good small face at `/sdcard/test-face.bin` (Type C, a few KB).
Do **not** commit real user faces — keep them local.
