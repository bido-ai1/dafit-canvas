// Web Bluetooth client for MO YOUNG / DA FIT smartwatches.
// Protocol mirrors https://github.com/david47k/dawfu (btleplug-based Rust CLI).
// Generic command framing matches Gadgetbridge's MoyoungPacketOut.buildPacket:
//   bytes 0..1: 0xFE 0xEA
//   bytes 2..3: size (high byte: 0x20 + (len>>8), low byte: len & 0xff)
//   byte 4    : opcode
//   bytes 5+  : payload
// No checksum. Notify char delivers replies in the same shape.

const MOYOUNG_SERVICE = 0xfeea
const SEND_CHAR = 0xfee2 // write w/o response — control commands
const SENDFILE_CHAR = 0xfee6 // write w/o response — chunk payload
const NOTIFY_CHAR = 0xfee3 // notify — watch acks

const DEVINFO_SERVICE = 0x180a
const MANUFACTURER_CHAR = 0x2a29
const SOFTREV_CHAR = 0x2a28
// 0x2a25 (Serial Number) is on the Web Bluetooth blocklist (exclude-reads)
// for privacy reasons, so we can't read it from a browser.

const BATTERY_SERVICE = 0x180f
const BATTERY_CHAR = 0x2a19

const CHUNK_SIZE = 244
const SLOT_GALLERY = 0x74 // file slot 116 = 103 + 13 (Watch Gallery)

// Robustness tuning for the upload flow (see issue #1 — BLE upload hang).
// Acceptance criterion: upload never hangs — it either succeeds or fails
// with a clear message within ~15s of the last progress.
export const CHUNK_TIMEOUT_MS = 10_000
export const MAX_CHUNK_RETRIES = 3
// Pacing between consecutive chunk writes. Android Chrome's BLE stack drops
// notifications when pushed too fast (DaFup uses 300ms; dawfu relies on
// per-chunk ACKs instead). Small delay keeps both models stable.
export const CHUNK_PACING_MS = 60

const REQUIRED_MANUFACTURER = 'MOYOUNG-V2'

const PREP_HEADER = [0xfe, 0xea, 0x20, 0x09, SLOT_GALLERY] as const
const READY_HEADER = [0xfe, 0xea, 0x20, 0x07, SLOT_GALLERY] as const
const APPLY_FACE_GALLERY = [0xfe, 0xea, 0x20, 0x06, 0x19, 0x0d] as const
// Extra transfer-config step observed in VicGuy/DaFup + jphein/moyoung-watch
// (proven on MOY-ERJ3 2.0.7): `fe ea 20 0a b4 11 30 04 00 00`.
// dawfu (the reference for this file) does NOT send it. Kept here as an
// opt-in for Icon Lite MOY-8Y82 testing — see UploadOptions below.
const FACE_SET_XFER = [
  0xfe, 0xea, 0x20, 0x0a, 0xb4, 0x11, 0x30, 0x04, 0x00, 0x00,
] as const

export type DeviceInfo = {
  name: string
  manufacturer: string
  software: string
  battery: number
}

export type UploadProgress = {
  bytesSent: number
  totalBytes: number
  chunkIndex: number
  totalChunks: number
}

export type UploadResult = {
  checksum: number
  totalBytes: number
}

export const isWebBluetoothSupported = (): boolean =>
  typeof navigator !== 'undefined' && 'bluetooth' in navigator

const decodeText = (view: DataView): string =>
  new TextDecoder('utf-8').decode(view).replace(/\0+$/, '')

const headerEquals = (a: Uint8Array, header: readonly number[]): boolean => {
  if (a.length < header.length) return false
  for (let i = 0; i < header.length; i++) if (a[i] !== header[i]) return false
  return true
}

export type UploadOptions = {
  /** AbortSignal to cancel an in-flight upload (Cancel button). */
  signal?: AbortSignal
  /** Per-chunk ACK timeout in ms. Defaults to CHUNK_TIMEOUT_MS. */
  chunkTimeoutMs?: number
  /** How many times to re-send a chunk after a timeout. Defaults to MAX_CHUNK_RETRIES. */
  maxRetries?: number
  /**
   * Opt-in: send the DaFup `FACE_SET_XFER` step
   * (`fe ea 20 0a b4 11 30 04 00 00`) between finish and apply.
   * Default false to preserve the proven dawfu sequence; enable when
   * testing Icon Lite MOY-8Y82 if apply alone does nothing.
   */
  sendTransferConfig?: boolean
}

export class MoyoungWatch {
  private device: BluetoothDevice | null = null
  private send: BluetoothRemoteGATTCharacteristic | null = null
  private sendFile: BluetoothRemoteGATTCharacteristic | null = null
  private notify: BluetoothRemoteGATTCharacteristic | null = null
  private onDisconnectCb: (() => void) | null = null
  private pendingUploadReject: ((err: Error) => void) | null = null

  async connect(): Promise<DeviceInfo> {
    if (!isWebBluetoothSupported()) {
      throw new Error(
        'Web Bluetooth is not supported in this browser. Use Chrome or Edge on desktop, served over HTTPS or localhost.',
      )
    }

    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [MOYOUNG_SERVICE, DEVINFO_SERVICE, BATTERY_SERVICE],
    })

    if (!device.gatt) {
      throw new Error('Selected device exposes no GATT server.')
    }

    device.addEventListener('gattserverdisconnected', this.handleDisconnect)
    const server = await device.gatt.connect()

    // Android Chrome's BLE stack serializes GATT operations strictly —
    // issuing multiple `getPrimaryService` / `getCharacteristic` /
    // `readValue` calls in parallel via `Promise.all` returns
    // "GATT operation failed for unknown reason" on the second one.
    // Desktop Chrome tolerates concurrent reads, but the safe baseline
    // (and what the spec actually requires of implementations) is
    // sequential `await`s — slightly slower on desktop, but identical
    // behaviour across platforms.
    const info = await server.getPrimaryService(DEVINFO_SERVICE)
    const battery = await server.getPrimaryService(BATTERY_SERVICE)
    const moyoung = await server.getPrimaryService(MOYOUNG_SERVICE)

    const manufacturerChar = await info.getCharacteristic(MANUFACTURER_CHAR)
    const softChar = await info.getCharacteristic(SOFTREV_CHAR)
    const batteryChar = await battery.getCharacteristic(BATTERY_CHAR)
    const send = await moyoung.getCharacteristic(SEND_CHAR)
    const sendFile = await moyoung.getCharacteristic(SENDFILE_CHAR)
    const notify = await moyoung.getCharacteristic(NOTIFY_CHAR)

    const manufacturer = decodeText(await manufacturerChar.readValue())
    const software = decodeText(await softChar.readValue())
    const batteryValue = (await batteryChar.readValue()).getUint8(0)

    if (manufacturer !== REQUIRED_MANUFACTURER) {
      device.gatt.disconnect()
      throw new Error(
        `Unsupported device. Manufacturer is "${manufacturer}", expected "${REQUIRED_MANUFACTURER}".`,
      )
    }

    this.device = device
    this.send = send
    this.sendFile = sendFile
    this.notify = notify

    return {
      name: device.name ?? '(unknown)',
      manufacturer,
      software,
      battery: batteryValue,
    }
  }

  onDisconnect(cb: (() => void) | null): void {
    this.onDisconnectCb = cb
  }

  async uploadWatchFace(
    file: ArrayBuffer,
    onProgress?: (p: UploadProgress) => void,
    options: UploadOptions = {},
  ): Promise<UploadResult> {
    const send = this.send
    const sendFile = this.sendFile
    const notify = this.notify
    if (!send || !sendFile || !notify) {
      throw new Error('Not connected.')
    }

    const totalBytes = file.byteLength
    if (totalBytes === 0) throw new Error('File is empty.')
    const totalChunks = Math.ceil(totalBytes / CHUNK_SIZE)
    const fileBytes = new Uint8Array(file)
    const chunkTimeoutMs = options.chunkTimeoutMs ?? CHUNK_TIMEOUT_MS
    const maxRetries = options.maxRetries ?? MAX_CHUNK_RETRIES
    const signal = options.signal

    if (signal?.aborted) throw new Error('Upload cancelled.')

    await notify.startNotifications()

    return new Promise<UploadResult>((resolve, reject) => {
      let expectedChunk = 0
      let settled = false
      let retriesForChunk = 0
      let chunkTimer: ReturnType<typeof setTimeout> | null = null
      // Strict serialization: only one GATT write in flight at a time.
      // Android Chrome fails concurrent GATT ops with
      // "GATT operation failed for unknown reason".
      let writeChain: Promise<void> = Promise.resolve()

      const clearTimer = () => {
        if (chunkTimer !== null) {
          clearTimeout(chunkTimer)
          chunkTimer = null
        }
      }

      const cleanup = () => {
        clearTimer()
        this.pendingUploadReject = null
        notify.removeEventListener('characteristicvaluechanged', onValue)
        notify.stopNotifications().catch(() => {})
        signal?.removeEventListener('abort', onAbort)
      }

      const fail = (err: unknown) => {
        if (settled) return
        settled = true
        cleanup()
        reject(err instanceof Error ? err : new Error(String(err)))
      }

      // Exposed to handleDisconnect so a mid-upload GATT drop rejects
      // instead of hanging forever (issue #1, hypothesis 7).
      this.pendingUploadReject = (err: Error) => fail(err)

      const succeed = (result: UploadResult) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(result)
      }

      const onAbort = () => {
        fail(new Error('Upload cancelled.'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })

      const queueWrite = (task: () => Promise<void>): void => {
        writeChain = writeChain.then(task).catch(fail)
      }

      const armTimeout = (chunkNum: number) => {
        clearTimer()
        chunkTimer = setTimeout(() => {
          if (settled) return
          if (retriesForChunk < maxRetries) {
            retriesForChunk += 1
            console.warn(
              `[moyoung] chunk ${chunkNum} ACK timeout (${chunkTimeoutMs}ms), retry ${retriesForChunk}/${maxRetries}`,
            )
            sendChunk(chunkNum)
          } else {
            fail(
              new Error(
                `Watch stopped responding at chunk ${chunkNum}/${totalChunks} ` +
                  `(${Math.round((chunkNum / totalChunks) * 100)}%). ` +
                  `Try a smaller file, move closer to the watch, disconnect the DaFit app, then retry.`,
              ),
            )
          }
        }, chunkTimeoutMs)
      }

      const sendChunk = (chunkNum: number) => {
        const start = chunkNum * CHUNK_SIZE
        if (start >= totalBytes) {
          fail(new Error(`Watch requested chunk ${chunkNum} past end of file`))
          return
        }
        const end = Math.min(start + CHUNK_SIZE, totalBytes)
        const chunk = fileBytes.subarray(start, end)
        armTimeout(chunkNum)
        queueWrite(async () => {
          if (settled) return
          // Small pacing keeps Android's BLE stack from dropping the notify.
          if (CHUNK_PACING_MS > 0) {
            await new Promise<void>((r) => setTimeout(r, CHUNK_PACING_MS))
          }
          if (settled) return
          await sendFile.writeValueWithoutResponse(chunk)
          onProgress?.({
            bytesSent: end,
            totalBytes,
            chunkIndex: chunkNum + 1,
            totalChunks,
          })
        })
      }

      const onValue = (event: Event) => {
        const target = event.target as BluetoothRemoteGATTCharacteristic
        const view = target.value
        if (!view) return
        const data = new Uint8Array(
          view.buffer,
          view.byteOffset,
          view.byteLength,
        )

        // Watch finished receiving the file → checksum at bytes 5..8 (BE u32).
        if (headerEquals(data, PREP_HEADER) && data.length >= 9) {
          clearTimer()
          const checksum =
            ((data[5] << 24) | (data[6] << 16) | (data[7] << 8) | data[8]) >>> 0
          queueWrite(async () => {
            try {
              await send.writeValueWithoutResponse(
                new Uint8Array([...PREP_HEADER, 0x00, 0x00, 0x00, 0x00]),
              )
              if (options.sendTransferConfig) {
                await send.writeValueWithoutResponse(
                  new Uint8Array([...FACE_SET_XFER]),
                )
              }
              await send.writeValueWithoutResponse(
                new Uint8Array(APPLY_FACE_GALLERY),
              )
              succeed({ checksum, totalBytes })
            } catch (err) {
              fail(err)
            }
          })
          return
        }

        // Watch ready for chunk N → bytes 5..6 carry chunk index (BE u16).
        if (headerEquals(data, READY_HEADER) && data.length >= 7) {
          clearTimer()
          const chunkNum = (data[5] << 8) | data[6]
          if (chunkNum !== expectedChunk) {
            console.warn(
              `[moyoung] expected chunk ${expectedChunk}, watch asked for ${chunkNum}`,
            )
          }
          // Watch re-asked for the same chunk → reset retry budget only
          // when it advances; duplicate requests don't consume retries.
          if (chunkNum !== expectedChunk - 1) retriesForChunk = 0
          expectedChunk = chunkNum + 1
          sendChunk(chunkNum)
          return
        }

        console.warn(
          '[moyoung] unexpected notification:',
          Array.from(data, (b) => b.toString(16).padStart(2, '0')).join(' '),
        )
      }

      notify.addEventListener('characteristicvaluechanged', onValue)

      // Send prep command: PREP_HEADER + size as BE u32.
      const prep = new Uint8Array(9)
      prep.set(PREP_HEADER)
      new DataView(prep.buffer).setUint32(5, totalBytes, false)
      armTimeout(0)
      queueWrite(async () => {
        if (settled) return
        await send.writeValueWithoutResponse(prep)
      })
    })
  }

  /** Build and send a generic Moyoung control packet on the SEND char.
   *  Payload defaults to empty (for opcodes like FIND_MY_WATCH that take
   *  no arguments). Throws if not connected. */
  async sendCommand(
    opcode: number,
    payload: Uint8Array = new Uint8Array(0),
  ): Promise<void> {
    const send = this.send
    if (!send) throw new Error('Not connected.')
    const total = payload.length + 5
    const packet = new Uint8Array(total)
    packet[0] = 0xfe
    packet[1] = 0xea
    // Use the MTU>20 size encoding (matches the existing upload flow:
    // byte[2] = 0x20 + (len>>8), byte[3] = len & 0xff). On Web Bluetooth
    // the negotiated MTU is generally well above 20 so this is the safe
    // default; if a watch insists on MTU=20 framing it can be added later.
    packet[2] = (0x20 + ((total >> 8) & 0xff)) & 0xff
    packet[3] = total & 0xff
    packet[4] = opcode & 0xff
    packet.set(payload, 5)
    await send.writeValueWithoutResponse(packet)
  }

  /** Subscribe to incoming control packets from the watch. The handler
   *  receives the parsed (opcode, payload) pair so callers don't have to
   *  re-decode the framing each time. `startNotifications` is called once
   *  per subscriber — Web Bluetooth allows multiple listeners on the same
   *  characteristic, and the upload flow uses its own listener in parallel
   *  without conflict. Returns an unsubscribe function. */
  async onPacket(
    handler: (opcode: number, payload: Uint8Array) => void,
  ): Promise<() => void> {
    const notify = this.notify
    if (!notify) throw new Error('Not connected.')
    await notify.startNotifications()
    const listener = (event: Event) => {
      const target = event.target as BluetoothRemoteGATTCharacteristic
      const view = target.value
      if (!view) return
      const data = new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
      // Drop anything that doesn't carry the Moyoung header — upload acks
      // share this framing too, but checking lets us ignore stray fragments
      // from other Web Bluetooth clients on the same characteristic.
      if (data.length < 5 || data[0] !== 0xfe || data[1] !== 0xea) return
      handler(data[4], data.subarray(5))
    }
    notify.addEventListener('characteristicvaluechanged', listener)
    return () => {
      notify.removeEventListener('characteristicvaluechanged', listener)
    }
  }

  async disconnect(): Promise<void> {
    const device = this.device
    this.device = null
    this.send = null
    this.sendFile = null
    this.notify = null
    this.pendingUploadReject?.(
      new Error('Disconnected during upload. Reconnect and retry.'),
    )
    this.pendingUploadReject = null
    if (device) {
      device.removeEventListener('gattserverdisconnected', this.handleDisconnect)
      if (device.gatt?.connected) device.gatt.disconnect()
    }
  }

  private handleDisconnect = () => {
    this.send = null
    this.sendFile = null
    this.notify = null
    // Reject a hung upload immediately instead of leaving the Promise
    // pending forever (issue #1, hypothesis 7).
    this.pendingUploadReject?.(
      new Error(
        'Watch disconnected mid-upload. Move closer, ensure the DaFit app is closed, then reconnect and retry.',
      ),
    )
    this.pendingUploadReject = null
    this.onDisconnectCb?.()
  }
}
