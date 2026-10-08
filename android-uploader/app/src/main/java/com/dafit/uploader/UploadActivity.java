package com.dafit.uploader;

import android.Manifest;
import android.app.Activity;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileWriter;
import java.io.InputStream;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Headless-friendly native BLE uploader for MOYOUNG-V2 / Da Fit watches.
 *
 * <p>Mirrors the exact wire sequence of the web app ({@code src/lib/moyoungBle.ts},
 * itself ported from david47k/dawfu) so results are directly comparable with the
 * Web Bluetooth flow — while giving us the real negotiated MTU and a reliable
 * GATT stack that Chrome on Android does not.
 *
 * <p>Launch headlessly (no taps) via Shizuku/rish shell, e.g.:
 * <pre>
 * am start -n com.dafit.uploader/.UploadActivity \
 *   -e deviceName "Icon Lite" -e file /sdcard/test-face.bin --ez xfer false
 * </pre>
 * The device is picked from <b>bonded</b> devices by name — no scan, no MAC needed.
 * Progress goes to logcat (tag {@code DafitUpload}), the final report to logcat AND
 * to {@code dafit-upload-result.txt} in the app's external files dir.
 */
public class UploadActivity extends Activity {
    private static final String TAG = "DafitUpload";

    // ---- GATT identifiers (same as moyoungBle.ts) ----
    private static final UUID SVC_FEEA = uuid16(0xFEEA);
    private static final UUID CHR_SEND = uuid16(0xFEE2);   // control, write-no-response
    private static final UUID CHR_DATA = uuid16(0xFEE6);   // chunk payload, write-no-response
    private static final UUID CHR_NOTIFY = uuid16(0xFEE3); // notify
    private static final UUID SVC_DEVINFO = uuid16(0x180A);
    private static final UUID CHR_MANUF = uuid16(0x2A29);
    private static final UUID CHR_SOFTREV = uuid16(0x2A28);
    private static final UUID SVC_BATTERY = uuid16(0x180F);
    private static final UUID CHR_BATTERY = uuid16(0x2A19);
    private static final UUID DESC_CCC = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");

    // ---- Protocol constants (same as moyoungBle.ts) ----
    private static final int CHUNK_SIZE = 244;
    private static final int SLOT_GALLERY = 0x74;
    private static final byte[] PREP_HEADER = {(byte) 0xFE, (byte) 0xEA, 0x20, 0x09, (byte) SLOT_GALLERY};
    private static final byte[] READY_HEADER = {(byte) 0xFE, (byte) 0xEA, 0x20, 0x07, (byte) SLOT_GALLERY};
    private static final byte[] APPLY_GALLERY = {(byte) 0xFE, (byte) 0xEA, 0x20, 0x06, 0x19, 0x0D};
    private static final byte[] FACE_SET_XFER = {
            (byte) 0xFE, (byte) 0xEA, 0x20, 0x0A, (byte) 0xB4, 0x11, 0x30, 0x04, 0x00, 0x00};

    private static final long CHUNK_TIMEOUT_MS = 10_000;
    private static final int MAX_RETRIES = 3;
    private static final long PACING_MS = 60;

    private TextView logView;
    private final StringBuilder logBuf = new StringBuilder();
    private Uri pickedUri = null;
    private Runnable pendingStart = null;
    private static final int REQ_PERMS = 1001;
    private static final int REQ_PICK_FILE = 1002;

    // Queues fed by the GATT callback thread.
    private final LinkedBlockingQueue<byte[]> notifyQ = new LinkedBlockingQueue<>();
    private final LinkedBlockingQueue<byte[]> readQ = new LinkedBlockingQueue<>();
    private final AtomicReference<CountDownLatch> connLatch = new AtomicReference<>();
    private final AtomicReference<CountDownLatch> svcLatch = new AtomicReference<>();
    private volatile int connState = -1;
    private volatile String lastHex = "";
    private volatile long lastHexAt = 0;

    private static UUID uuid16(int v) {
        return UUID.fromString(String.format(Locale.US, "0000%04x-0000-1000-8000-00805f9b34fb", v));
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        logView = new TextView(this);
        logView.setTextIsSelectable(true);
        logView.setTextSize(13);
        ScrollView sv = new ScrollView(this);
        sv.addView(logView);
        setContentView(sv);
        handleIntent(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        handleIntent(intent);
    }

    private void handleIntent(Intent intent) {
        String deviceName = intent != null ? intent.getStringExtra("deviceName") : null;
        String file = intent != null ? intent.getStringExtra("file") : null;
        boolean xfer = intent != null && intent.getBooleanExtra("xfer", false);
        if (deviceName == null) deviceName = "Icon Lite";
        if (file == null || file.isEmpty()) {
            // Tapped icon / no extras → manual form so the app is usable
            // by touch, no shell commands needed.
            final String dev = deviceName;
            final boolean useXfer = xfer;
            runOnUiThread(() -> showManualForm(dev, useXfer));
            return;
        }
        final String dev = deviceName;
        final String path = file;
        final boolean useXfer = xfer;
        new Thread(() -> {
            try {
                byte[] image = readAll(new File(path));
                log("file=" + path + " size=" + image.length + "B chunks="
                        + ((image.length + CHUNK_SIZE - 1) / CHUNK_SIZE));
                runUploadBytes(dev, image, path, useXfer);
            } catch (Exception e) {
                report("FATAL: " + e, null);
            }
        }, "dafit-upload").start();
    }

    // ---------------- manual (touch) mode ----------------

    private void showManualForm(String defaultDev, boolean defaultXfer) {
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        int pad = (int) (12 * getResources().getDisplayMetrics().density);
        root.setPadding(pad, pad, pad, pad);

        final EditText devInput = new EditText(this);
        devInput.setHint("Watch name (bonded)");
        devInput.setText(defaultDev);
        root.addView(devInput);

        LinearLayout fileRow = new LinearLayout(this);
        fileRow.setOrientation(LinearLayout.HORIZONTAL);
        final EditText fileInput = new EditText(this);
        fileInput.setHint("Watch face .bin");
        fileInput.setText("/sdcard/test-face.bin");
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0,
                LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        fileRow.addView(fileInput, lp);
        Button pickBtn = new Button(this);
        pickBtn.setText("…");
        pickBtn.setOnClickListener(v -> {
            Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
            i.setType("*/*");
            i.addCategory(Intent.CATEGORY_OPENABLE);
            startActivityForResult(i, REQ_PICK_FILE);
        });
        fileRow.addView(pickBtn);
        root.addView(fileRow);

        final CheckBox xferBox = new CheckBox(this);
        xferBox.setText("Send transfer-config step (DaFup)");
        xferBox.setChecked(defaultXfer);
        root.addView(xferBox);

        Button startBtn = new Button(this);
        startBtn.setText("Send to watch");
        root.addView(startBtn);

        logView.setText(logBuf.toString());
        ScrollView sv = new ScrollView(this);
        sv.addView(logView);
        root.addView(sv, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));
        setContentView(root);

        ui("Manual mode: pick a .bin (or type its path), then Send to watch.\n"
                + "The watch must be BONDED and the DaFit app closed.\n");

        startBtn.setOnClickListener(v -> {
            final String dev = devInput.getText().toString().trim();
            final String pathTxt = fileInput.getText().toString().trim();
            final boolean useXfer = xferBox.isChecked();
            ensurePermsThen(() -> new Thread(() -> {
                try {
                    byte[] image;
                    String label;
                    if (pickedUri != null && pathTxt.startsWith("content:")) {
                        image = readUri(pickedUri);
                        label = pickedUri.toString();
                    } else {
                        File f = new File(pathTxt);
                        if (!f.exists()) {
                            report("FAIL: file not found: " + pathTxt
                                    + " — use the … button to pick a .bin, or copy one there.", null);
                            return;
                        }
                        image = readAll(f);
                        label = pathTxt;
                    }
                    log("file=" + label + " size=" + image.length + "B chunks="
                            + ((image.length + CHUNK_SIZE - 1) / CHUNK_SIZE));
                    runUploadBytes(dev.isEmpty() ? "Icon Lite" : dev, image, label, useXfer);
                } catch (Exception e) {
                    report("FATAL: " + e, null);
                }
            }, "dafit-upload").start());
        });
    }

    private void ensurePermsThen(Runnable r) {
        java.util.ArrayList<String> missing = new java.util.ArrayList<>();
        if (checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT)
                != PackageManager.PERMISSION_GRANTED) {
            missing.add(Manifest.permission.BLUETOOTH_CONNECT);
        }
        if (checkSelfPermission(Manifest.permission.BLUETOOTH_SCAN)
                != PackageManager.PERMISSION_GRANTED) {
            missing.add(Manifest.permission.BLUETOOTH_SCAN);
        }
        if (checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
                != PackageManager.PERMISSION_GRANTED) {
            missing.add(Manifest.permission.ACCESS_FINE_LOCATION);
        }
        if (Build.VERSION.SDK_INT <= 32 && checkSelfPermission(
                Manifest.permission.READ_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
            missing.add(Manifest.permission.READ_EXTERNAL_STORAGE);
        }
        if (missing.isEmpty()) {
            r.run();
        } else {
            pendingStart = r;
            requestPermissions(missing.toArray(new String[0]), REQ_PERMS);
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_PERMS) {
            boolean ok = true;
            for (int g : grantResults) if (g != PackageManager.PERMISSION_GRANTED) ok = false;
            if (ok && pendingStart != null) {
                Runnable r = pendingStart;
                pendingStart = null;
                r.run();
            } else {
                ui("Permissions denied — grant Bluetooth/Location to upload.\n");
            }
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQ_PICK_FILE && resultCode == RESULT_OK && data != null
                && data.getData() != null) {
            pickedUri = data.getData();
            try {
                getContentResolver().takePersistableUriPermission(pickedUri,
                        Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (Exception ignored) {
            }
            ui("picked: " + pickedUri + "\n");
            // Reflect into the visible file field if the form is showing.
            android.view.View root = findViewById(android.R.id.content);
            if (root instanceof android.view.ViewGroup) {
                setFileFieldText((android.view.ViewGroup) root, pickedUri.toString());
            }
        }
    }

    private void setFileFieldText(android.view.ViewGroup g, String text) {
        for (int i = 0; i < g.getChildCount(); i++) {
            android.view.View c = g.getChildAt(i);
            if (c instanceof EditText && ((EditText) c).getHint() != null
                    && ((EditText) c).getHint().toString().contains(".bin")) {
                ((EditText) c).setText(text);
                return;
            }
            if (c instanceof android.view.ViewGroup) setFileFieldText((android.view.ViewGroup) c, text);
        }
    }

    private byte[] readUri(Uri uri) throws Exception {
        try (InputStream in = getContentResolver().openInputStream(uri)) {
            if (in == null) throw new Exception("cannot open " + uri);
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] tmp = new byte[8192];
            int r;
            long total = 0;
            while ((r = in.read(tmp)) >= 0) {
                total += r;
                if (total > 2_000_000) throw new Exception("file too large");
                bos.write(tmp, 0, r);
            }
            return bos.toByteArray();
        }
    }

    // ---------------- upload flow ----------------

    private void runUploadBytes(String deviceName, byte[] image, String label, boolean useXfer) throws Exception {
        if (image.length == 0) {
            report("FAIL: empty file: " + label, null);
            return;
        }

        BluetoothManager bm = (BluetoothManager) getSystemService(Context.BLUETOOTH_SERVICE);
        if (bm == null) {
            report("FAIL: no BluetoothManager", null);
            return;
        }
        BluetoothAdapter adapter = bm.getAdapter();
        if (adapter == null || !adapter.isEnabled()) {
            report("FAIL: bluetooth off or unavailable", null);
            return;
        }
        BluetoothDevice dev = null;
        Set<BluetoothDevice> bonded;
        try {
            bonded = adapter.getBondedDevices();
        } catch (SecurityException se) {
            report("FAIL: BLUETOOTH_CONNECT not granted. Run: pm grant com.dafit.uploader android.permission.BLUETOOTH_CONNECT — " + se, null);
            return;
        }
        for (BluetoothDevice d : bonded) {
            String n;
            try {
                n = d.getName();
            } catch (SecurityException se) {
                continue;
            }
            if (deviceName.equals(n)) {
                dev = d;
                break;
            }
        }
        if (dev == null) {
            report("FAIL: no bonded device named '" + deviceName + "'. Bond the watch first (Da Fit app or system settings).", null);
            return;
        }
        log("bonded device found: " + deviceName);

        GattCtx ctx = new GattCtx();
        CountDownLatch cl = new CountDownLatch(1);
        connLatch.set(cl);
        BluetoothGatt gatt;
        try {
            gatt = dev.connectGatt(this, false, ctx, BluetoothDevice.TRANSPORT_LE);
        } catch (SecurityException se) {
            report("FAIL: connectGatt needs BLUETOOTH_CONNECT: " + se, null);
            return;
        }
        if (gatt == null) {
            report("FAIL: connectGatt returned null", null);
            return;
        }
        if (!cl.await(20, TimeUnit.SECONDS) || connState != BluetoothProfile.STATE_CONNECTED) {
            report("FAIL: GATT connect timeout (state=" + connState + ")", gatt);
            return;
        }
        log("GATT connected");

        CountDownLatch sl = new CountDownLatch(1);
        svcLatch.set(sl);
        try {
            gatt.discoverServices();
        } catch (SecurityException se) {
            report("FAIL: discoverServices needs BLUETOOTH_CONNECT", gatt);
            return;
        }
        if (!sl.await(15, TimeUnit.SECONDS)) {
            report("FAIL: discoverServices timeout", gatt);
            return;
        }

        BluetoothGattService feea = gatt.getService(SVC_FEEA);
        BluetoothGattService info = gatt.getService(SVC_DEVINFO);
        BluetoothGattService batt = gatt.getService(SVC_BATTERY);
        if (feea == null || info == null) {
            report("FAIL: missing 0xFEEA/0x180A services — not a MOYOUNG-V2 watch?", gatt);
            return;
        }
        BluetoothGattCharacteristic chSend = feea.getCharacteristic(CHR_SEND);
        BluetoothGattCharacteristic chData = feea.getCharacteristic(CHR_DATA);
        BluetoothGattCharacteristic chNotify = feea.getCharacteristic(CHR_NOTIFY);
        if (chSend == null || chData == null || chNotify == null) {
            report("FAIL: missing 0xFEE2/0xFEE6/0xFEE3 characteristics", gatt);
            return;
        }

        String manuf = readStr(gatt, info.getCharacteristic(CHR_MANUF), 5);
        String soft = readStr(gatt, info.getCharacteristic(CHR_SOFTREV), 5);
        String battery = "";
        if (batt != null && batt.getCharacteristic(CHR_BATTERY) != null) {
            byte[] b = readBytes(gatt, batt.getCharacteristic(CHR_BATTERY), 5);
            if (b != null && b.length > 0) battery = String.valueOf(b[0] & 0xFF) + "%";
        }
        log("manufacturer=" + manuf + " softrev=" + soft + " battery=" + battery);
        try {
            int mtu = gatt.requestMtu(247) ? 247 : -1;
            log("requestMtu(247) issued, rc=" + mtu + " (proceeding regardless)");
        } catch (Exception e) {
            log("requestMtu failed (non-fatal): " + e);
        }
        if (!"MOYOUNG-V2".equals(manuf)) {
            report("FAIL: manufacturer is '" + manuf + "', expected MOYOUNG-V2", gatt);
            return;
        }
        Thread.sleep(300);

        // Enable notifications on 0xFEE3.
        try {
            gatt.setCharacteristicNotification(chNotify, true);
            BluetoothGattDescriptor ccc = chNotify.getDescriptor(DESC_CCC);
            if (ccc != null) {
                ccc.setValue(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE);
                gatt.writeDescriptor(ccc);
                Thread.sleep(400);
            }
        } catch (SecurityException se) {
            report("FAIL: notify setup needs BLUETOOTH_CONNECT", gatt);
            return;
        }
        notifyQ.clear();

        int totalChunks = (image.length + CHUNK_SIZE - 1) / CHUNK_SIZE;
        byte[] prep = new byte[9];
        System.arraycopy(PREP_HEADER, 0, prep, 0, 5);
        prep[5] = (byte) ((image.length >>> 24) & 0xFF);
        prep[6] = (byte) ((image.length >>> 16) & 0xFF);
        prep[7] = (byte) ((image.length >>> 8) & 0xFF);
        prep[8] = (byte) (image.length & 0xFF);
        writeNoResp(gatt, chSend, prep);
        log("TX prep len=" + image.length + " hex=" + hex(prep));

        int expected = 0;
        int retries = 0;
        int chunksAcked = 0;
        long deadline = System.currentTimeMillis() + CHUNK_TIMEOUT_MS;
        boolean done = false;
        String completionHex = null;
        long completionVal = 0;

        while (!done) {
            long wait = deadline - System.currentTimeMillis();
            if (wait <= 0) wait = 1;
            byte[] n = notifyQ.poll(wait, TimeUnit.MILLISECONDS);
            if (n == null) {
                if (retries < MAX_RETRIES && expected < totalChunks) {
                    retries++;
                    log("WARN chunk " + expected + " ACK timeout, resending last chunk (retry " + retries + "/" + MAX_RETRIES + ")");
                    sendChunk(gatt, chData, image, expected, totalChunks);
                    deadline = System.currentTimeMillis() + CHUNK_TIMEOUT_MS;
                    continue;
                }
                report("FAIL: timeout waiting for chunk " + expected + "/" + totalChunks + " after " + MAX_RETRIES + " retries", gatt);
                return;
            }
            log("RX " + hex(n));
            if (startsWith(n, PREP_HEADER) && n.length >= 9) {
                completionHex = hex(n);
                completionVal = ((n[5] & 0xFFL) << 24) | ((n[6] & 0xFFL) << 16)
                        | ((n[7] & 0xFFL) << 8) | (n[8] & 0xFFL);
                chunksAcked = expected;
                done = true;
                break;
            }
            if (startsWith(n, READY_HEADER) && n.length >= 7) {
                int chunk = ((n[5] & 0xFF) << 8) | (n[6] & 0xFF);
                if (chunk != expected) log("WARN expected chunk " + expected + " got " + chunk);
                if (chunk != expected - 1) retries = 0;
                expected = chunk + 1;
                if (chunk * CHUNK_SIZE >= image.length) {
                    report("FAIL: watch requested chunk " + chunk + " past end of file", gatt);
                    return;
                }
                sendChunk(gatt, chData, image, chunk, totalChunks);
                deadline = System.currentTimeMillis() + CHUNK_TIMEOUT_MS;
                continue;
            }
            log("WARN unexpected notification (ignored)");
        }

        boolean endedEarly = chunksAcked < totalChunks;
        log("completion value=0x" + String.format(Locale.US, "%08x", completionVal)
                + " raw=" + completionHex + " chunksAcked=" + chunksAcked + "/" + totalChunks
                + (endedEarly ? " ENDED_EARLY" : ""));

        Thread.sleep(200);
        byte[] finish = new byte[]{PREP_HEADER[0], PREP_HEADER[1], PREP_HEADER[2], PREP_HEADER[3],
                PREP_HEADER[4], 0, 0, 0, 0};
        writeNoResp(gatt, chSend, finish);
        log("TX finish");
        Thread.sleep(200);
        if (useXfer) {
            writeNoResp(gatt, chSend, FACE_SET_XFER);
            log("TX face_set_xfer (opt-in ON)");
            Thread.sleep(200);
        }
        writeNoResp(gatt, chSend, APPLY_GALLERY);
        log("TX apply_gallery (slot 13)");
        Thread.sleep(800);

        String verdict = "OK sent=" + image.length + "B checksum=0x"
                + String.format(Locale.US, "%08x", completionVal)
                + " raw=" + completionHex
                + " chunks=" + chunksAcked + "/" + totalChunks
                + " xfer=" + useXfer
                + (endedEarly ? " WARNING_ENDED_EARLY(file likely rejected)" : "")
                + (completionVal == 0xFFFF0000L ? " NOTE_FFFF0000(status, not checksum)" : "");
        try {
            gatt.disconnect();
        } catch (Exception ignored) {
        }
        try {
            gatt.close();
        } catch (Exception ignored) {
        }
        report(verdict, null);
    }

    private void sendChunk(BluetoothGatt gatt, BluetoothGattCharacteristic ch,
                           byte[] image, int chunk, int total) throws Exception {
        int start = chunk * CHUNK_SIZE;
        int end = Math.min(start + CHUNK_SIZE, image.length);
        byte[] buf = new byte[end - start];
        System.arraycopy(image, start, buf, 0, buf.length);
        if (PACING_MS > 0) Thread.sleep(PACING_MS);
        writeNoResp(gatt, ch, buf);
        ui("chunk " + (chunk + 1) + "/" + total + " · " + end + "/" + image.length + "B");
        Log.i(TAG, "TX chunk " + chunk + " len=" + buf.length);
    }

    // ---------------- BLE helpers ----------------

    private class GattCtx extends BluetoothGattCallback {
        @Override
        public void onConnectionStateChange(BluetoothGatt g, int status, int newState) {
            connState = newState;
            CountDownLatch l = connLatch.get();
            if (l != null) l.countDown();
            if (newState != BluetoothProfile.STATE_CONNECTED) {
                log("GATT disconnected (status=" + status + ")");
            }
        }

        @Override
        public void onServicesDiscovered(BluetoothGatt g, int status) {
            CountDownLatch l = svcLatch.get();
            if (l != null) l.countDown();
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c) {
            enqueueNotify(c.getValue());
        }

        @Override
        public void onCharacteristicChanged(BluetoothGatt g, BluetoothGattCharacteristic c, byte[] value) {
            enqueueNotify(value);
        }

        @Override
        public void onCharacteristicRead(BluetoothGatt g, BluetoothGattCharacteristic c, int status) {
            if (status == BluetoothGatt.GATT_SUCCESS) readQ.offer(c.getValue());
            else readQ.offer(new byte[0]);
        }

        @Override
        public void onMtuChanged(BluetoothGatt g, int mtu, int status) {
            log("onMtuChanged mtu=" + mtu + " status=" + status);
        }
    }

    /** De-dupes the double-callback case on API 33+ (both overloads may fire). */
    private void enqueueNotify(byte[] v) {
        if (v == null) return;
        String h = hex(v);
        long now = System.currentTimeMillis();
        if (h.equals(lastHex) && now - lastHexAt < 200) return;
        lastHex = h;
        lastHexAt = now;
        notifyQ.offer(v);
    }

    private void writeNoResp(BluetoothGatt gatt, BluetoothGattCharacteristic ch, byte[] data) throws Exception {
        try {
            if (Build.VERSION.SDK_INT >= 33) {
                int rc = gatt.writeCharacteristic(ch, data, BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
                if (rc != BluetoothGatt.GATT_SUCCESS) throw new Exception("writeCharacteristic rc=" + rc);
            } else {
                ch.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE);
                ch.setValue(data);
                if (!gatt.writeCharacteristic(ch)) throw new Exception("writeCharacteristic returned false");
            }
        } catch (SecurityException se) {
            throw new Exception("write needs BLUETOOTH_CONNECT: " + se);
        }
    }

    private byte[] readBytes(BluetoothGatt gatt, BluetoothGattCharacteristic ch, long timeoutSec) throws Exception {
        if (ch == null) return null;
        readQ.clear();
        try {
            if (!gatt.readCharacteristic(ch)) return null;
        } catch (SecurityException se) {
            throw new Exception("read needs BLUETOOTH_CONNECT: " + se);
        }
        return readQ.poll(timeoutSec, TimeUnit.SECONDS);
    }

    private String readStr(BluetoothGatt gatt, BluetoothGattCharacteristic ch, long timeoutSec) throws Exception {
        byte[] b = readBytes(gatt, ch, timeoutSec);
        if (b == null) return "(read-timeout)";
        int n = b.length;
        while (n > 0 && b[n - 1] == 0) n--;
        return new String(b, 0, n, "UTF-8");
    }

    private static boolean startsWith(byte[] a, byte[] prefix) {
        if (a.length < prefix.length) return false;
        for (int i = 0; i < prefix.length; i++) if (a[i] != prefix[i]) return false;
        return true;
    }

    private static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) sb.append(String.format(Locale.US, "%02x", x & 0xFF));
        return sb.toString();
    }

    private static byte[] readAll(File f) throws Exception {
        long len = f.length();
        if (len <= 0 || len > 2_000_000) throw new Exception("bad file size: " + len + " (" + f.getAbsolutePath() + ")");
        byte[] out = new byte[(int) len];
        try (InputStream in = new FileInputStream(f)) {
            int off = 0;
            while (off < out.length) {
                int r = in.read(out, off, out.length - off);
                if (r < 0) break;
                off += r;
            }
            if (off != out.length) throw new Exception("short read: " + off + "/" + out.length);
        }
        return out;
    }

    // ---------------- reporting ----------------

    private void log(String s) {
        Log.i(TAG, s);
        ui(s);
    }

    private void ui(final String s) {
        synchronized (logBuf) {
            logBuf.append(s).append('\n');
        }
        runOnUiThread(() -> logView.setText(logBuf.toString()));
    }

    private void report(String verdict, BluetoothGatt gatt) {
        if (gatt != null) {
            try {
                gatt.disconnect();
            } catch (Exception ignored) {
            }
            try {
                gatt.close();
            } catch (Exception ignored) {
            }
        }
        Log.i(TAG, "RESULT: " + verdict);
        ui("RESULT: " + verdict);
        String body;
        synchronized (logBuf) {
            body = logBuf + "RESULT: " + verdict + "\n";
        }
        // Primary: app-external files dir (always writable, readable via shell).
        try {
            File dir = getExternalFilesDir(null);
            if (dir != null) {
                File out = new File(dir, "dafit-upload-result.txt");
                try (FileWriter w = new FileWriter(out, false)) {
                    w.write(body);
                }
                Log.i(TAG, "wrote " + out.getAbsolutePath());
            }
        } catch (Exception e) {
            Log.w(TAG, "result file write failed: " + e);
        }
        // Best-effort mirror to Download for easy `cat`.
        try {
            File dl = new File("/sdcard/Download/dafit-upload-result.txt");
            try (FileWriter w = new FileWriter(dl, false)) {
                w.write(body);
            }
        } catch (Exception e) {
            Log.i(TAG, "Download mirror skipped: " + e);
        }
    }
}
