import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  BoxSelect,
  Check,
  Eraser,
  Grid3x3,
  PaintBucket,
  Pencil,
  Pipette,
  Redo2,
  Trash2,
  Undo2,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react'
import Tooltip from '../Tooltip'

type Tool = 'pencil' | 'eraser' | 'bucket' | 'eye' | 'select'

type SelectionRect = { x: number; y: number; w: number; h: number }

type FloatingPixels = {
  rgba: Uint8ClampedArray
  w: number
  h: number
}

/** What kind of pointer drag is in progress while the Select tool is
 *  active. `select` = drawing a new rectangle; `move` = translating the
 *  current selection (lifting + relocating the pixels under it). */
type SelectDrag =
  | { kind: 'select'; startX: number; startY: number }
  | {
      kind: 'move'
      mouseStartX: number
      mouseStartY: number
      rectStartX: number
      rectStartY: number
    }

type Props = {
  /** Initial RGBA buffer (top-down, premultiplied by Canvas conventions —
   *  same shape `replaceAssetAction` consumes). `null` seeds a transparent
   *  canvas at width × height. */
  rgba: Uint8ClampedArray | null
  width: number
  height: number
  /** Displayed in the editor's title bar. */
  name: string
  /** Called with the edited RGBA + dimensions when the user clicks Save. */
  onSave: (rgba: Uint8ClampedArray, width: number, height: number) => void
  onClose: () => void
}

/** Eight starter swatches — black, white, two greys, plus pure-ish primaries.
 *  Watch faces tend to live in this palette plus the user's accent picks. */
const PRESETS = [
  '#000000',
  '#ffffff',
  '#808080',
  '#c0c0c0',
  '#ff3b30',
  '#ff9500',
  '#ffcc00',
  '#34c759',
  '#00c7be',
  '#5ac8fa',
  '#007aff',
  '#af52de',
  '#ff2d92',
  '#a2845e',
] as const

const HISTORY_LIMIT = 50
const MIN_ZOOM = 1
const MAX_ZOOM = 40

const seedPixels = (
  src: Uint8ClampedArray | null,
  w: number,
  h: number,
): Uint8ClampedArray => {
  const out = new Uint8ClampedArray(w * h * 4)
  if (src && src.length === out.length) out.set(src)
  return out
}

/** Initial zoom — scale so the image lands around 480px on its longest
 *  side, but never go below 1× or above the hard cap. */
const initialZoom = (w: number, h: number): number => {
  if (w === 0 || h === 0) return 16
  const fit = Math.floor(Math.min(480 / w, 480 / h))
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, fit || 1))
}

const parseHex = (hex: string): [number, number, number] => {
  const m = /^#([0-9a-f]{6})$/i.exec(hex)
  if (!m) return [0, 0, 0]
  const v = parseInt(m[1], 16)
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]
}

const toHex = (r: number, g: number, b: number): string =>
  '#' +
  [r, g, b]
    .map((c) => c.toString(16).padStart(2, '0'))
    .join('')

function BmpPixelEditor({
  rgba,
  width: initialWidth,
  height: initialHeight,
  name,
  onSave,
  onClose,
}: Props) {
  // Dimensions are state, not props, so the crop tool can resize the buffer
  // mid-edit. The initial values come from props.
  const [dims, setDims] = useState<{ w: number; h: number }>({
    w: initialWidth,
    h: initialHeight,
  })
  const width = dims.w
  const height = dims.h

  // The current image buffer lives in a ref + a render-tick counter so we
  // can mutate in place during a stroke (one allocation per *stroke*, not
  // per pixel). React re-renders / the canvas effect re-runs whenever the
  // tick bumps.
  const pixelsRef = useRef<Uint8ClampedArray>(
    seedPixels(rgba, initialWidth, initialHeight),
  )
  const [, setTick] = useState(0)
  const repaint = () => setTick((t) => t + 1)

  const [tool, setTool] = useState<Tool>('pencil')
  const [color, setColor] = useState<string>('#ffffff')
  const [zoom, setZoom] = useState<number>(() =>
    initialZoom(initialWidth, initialHeight),
  )
  const [showGrid, setShowGrid] = useState<boolean>(true)
  // Current marquee selection — null when nothing selected. The rect
  // moves with the floating pixels during a move drag, so its position
  // always reflects where the float will land on commit.
  const [cropRect, setCropRect] = useState<SelectionRect | null>(null)
  const cropRectRef = useRef<SelectionRect | null>(null)
  cropRectRef.current = cropRect
  // Lifted pixels — populated when the user drags inside an existing
  // selection. The source area in `pixelsRef` is cleared while these
  // are floating, and they're composited back at the selection's
  // current position on commit.
  const floatingRef = useRef<FloatingPixels | null>(null)
  const dragRef = useRef<SelectDrag | null>(null)
  // applyCrop is called from a global keydown handler whose closure is
  // captured once; this ref keeps the latest impl reachable from there.
  const applyCropRef = useRef<() => void>(() => {})

  // In-editor undo stacks — separate from the project-level undo. State
  // (not refs) so React re-renders disable Undo/Redo buttons in lockstep.
  // The byte buffers inside each entry are immutable snapshots.
  const [undoStack, setUndoStack] = useState<Uint8ClampedArray[]>([])
  const [redoStack, setRedoStack] = useState<Uint8ClampedArray[]>([])
  const canUndo = undoStack.length > 0
  const canRedo = redoStack.length > 0

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const gridRef = useRef<HTMLCanvasElement>(null)
  const pointerRef = useRef<{
    isDown: boolean
    lastX: number
    lastY: number
    activeTool: Tool
  }>({ isDown: false, lastX: -1, lastY: -1, activeTool: 'pencil' })

  /** Snapshot the current buffer onto the undo stack and reset redo.
   *  The snapshot is taken *synchronously* — React 18 batches state
   *  updates, so any code that mutates `pixelsRef` after this call
   *  (e.g. `writePixel` further down in `onPointerDown`) would
   *  otherwise leak into the snapshot when the updater runs at the
   *  end of the event handler. */
  const pushUndo = () => {
    const snapshot = new Uint8ClampedArray(pixelsRef.current)
    setUndoStack((s) => {
      const next = s.length >= HISTORY_LIMIT ? s.slice(1) : s.slice()
      next.push(snapshot)
      return next
    })
    setRedoStack([])
  }

  const doUndo = () => {
    // Capture the current state before queuing any updates so the redo
    // stack gets the *pre-undo* buffer, not the one we're about to
    // restore into `pixelsRef`.
    const currentSnapshot = new Uint8ClampedArray(pixelsRef.current)
    setUndoStack((s) => {
      if (s.length === 0) return s
      const prev = s[s.length - 1]
      pixelsRef.current = prev
      setRedoStack((r) => [...r, currentSnapshot])
      repaint()
      return s.slice(0, -1)
    })
  }

  const doRedo = () => {
    const currentSnapshot = new Uint8ClampedArray(pixelsRef.current)
    setRedoStack((s) => {
      if (s.length === 0) return s
      const next = s[s.length - 1]
      pixelsRef.current = next
      setUndoStack((u) => [...u, currentSnapshot])
      repaint()
      return s.slice(0, -1)
    })
  }

  // Esc to close (or cancel pending crop first), body scroll lock,
  // Cmd/Ctrl-Z stack handlers, single-letter tool shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Don't steal typing in inputs (the colour `<input type=color>` etc.).
      const target = e.target as HTMLElement | null
      const inField =
        !!target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      if (e.key === 'Escape') {
        if (cropRectRef.current) {
          setCropRect(null)
          return
        }
        onClose()
        return
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) doRedo()
        else doUndo()
        return
      }
      if (cropRectRef.current && (e.key === 'Enter' || e.key === 'Return')) {
        e.preventDefault()
        applyCropRef.current()
        return
      }
      if (inField || e.metaKey || e.ctrlKey || e.altKey) return
      switch (e.key.toLowerCase()) {
        case 'p':
          setCropRect(null)
          setTool('pencil')
          break
        case 'e':
          setCropRect(null)
          setTool('eraser')
          break
        case 'b':
          setCropRect(null)
          setTool('bucket')
          break
        case 'i':
          setCropRect(null)
          setTool('eye')
          break
        case 'c':
          setTool('select')
          break
      }
    }
    document.addEventListener('keydown', onKey)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      document.body.style.overflow = prev
    }
    // doUndo / doRedo / applyCrop use functional setState + refs internally,
    // so the
    // closure capturing the first-render instances stays correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onClose])

  // Render the pixel buffer to the canvas at 1:1 — CSS scales it up for
  // display via the rendered width/height. Re-runs on every paint via the
  // dependency on `pixelsRef`'s tick. Floating selection pixels (if any)
  // are composited on top via a temporary canvas + source-over drawImage
  // so they respect alpha against the cleared source area underneath.
  // Pending channel-offset slider values are previewed live by routing
  // both the main buffer and the float through `computeOffsetPreview`
  // before paint — `pixelsRef` itself doesn't change until Apply.
  useLayoutEffect(() => {
    const c = canvasRef.current
    if (!c) return
    c.width = width
    c.height = height
    const ctx = c.getContext('2d')
    if (!ctx) return
    const mainSrc = hasChannelOffsets
      ? computeOffsetPreview(pixelsRef.current, channelOffsets, false)
      : pixelsRef.current
    const img = ctx.createImageData(width, height)
    img.data.set(mainSrc)
    ctx.putImageData(img, 0, 0)
    const f = floatingRef.current
    const r = cropRect
    if (f && r) {
      const floatSrc = hasChannelOffsets
        ? computeOffsetPreview(f.rgba, channelOffsets, true)
        : f.rgba
      const tmp = document.createElement('canvas')
      tmp.width = f.w
      tmp.height = f.h
      const tctx = tmp.getContext('2d')
      if (tctx) {
        const fImg = tctx.createImageData(f.w, f.h)
        fImg.data.set(floatSrc)
        tctx.putImageData(fImg, 0, 0)
        ctx.drawImage(tmp, r.x, r.y)
      }
    }
  })

  // Pixel grid overlay — only drawn when there's enough room per cell
  // (>=8 CSS px) so it doesn't add noise on small zooms.
  useLayoutEffect(() => {
    const c = gridRef.current
    if (!c) return
    const cw = width * zoom
    const ch = height * zoom
    c.width = cw
    c.height = ch
    const ctx = c.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, cw, ch)
    if (!showGrid || zoom < 8) return
    ctx.strokeStyle = 'rgba(0, 0, 0, 0.25)'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (let x = 0; x <= width; x++) {
      ctx.moveTo(x * zoom + 0.5, 0)
      ctx.lineTo(x * zoom + 0.5, ch)
    }
    for (let y = 0; y <= height; y++) {
      ctx.moveTo(0, y * zoom + 0.5)
      ctx.lineTo(cw, y * zoom + 0.5)
    }
    ctx.stroke()
  }, [width, height, zoom, showGrid])

  /** Translate a pointer event's client coords into pixel coords inside
   *  the image. The canvas's `getBoundingClientRect` reflects its CSS-
   *  scaled size, so we map proportionally. */
  const clientToPixel = (
    clientX: number,
    clientY: number,
  ): { x: number; y: number } | null => {
    const c = canvasRef.current
    if (!c) return null
    const rect = c.getBoundingClientRect()
    const x = Math.floor(((clientX - rect.left) * width) / rect.width)
    const y = Math.floor(((clientY - rect.top) * height) / rect.height)
    if (x < 0 || x >= width || y < 0 || y >= height) return null
    return { x, y }
  }

  /** Set or clear a single pixel without bookkeeping — used by stroke
   *  helpers below. Doesn't trigger a render on its own; caller calls
   *  `repaint()` after a batch.
   *
   *  Eraser fills opaque black rather than zero-alpha: the watch's BMP
   *  format is RGB565 with no alpha channel, so the encoder
   *  ([encodeRgb565Raw](src/lib/dawft.ts:665)) drops alpha entirely
   *  and a "transparent" pixel would still ship as black. Painting
   *  the actual export colour keeps the editor honest. */
  const writePixel = (x: number, y: number, t: Tool, hex: string) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return
    const i = (y * width + x) * 4
    const buf = pixelsRef.current
    if (t === 'eraser') {
      buf[i] = 0
      buf[i + 1] = 0
      buf[i + 2] = 0
      buf[i + 3] = 255
      return
    }
    const [r, g, b] = parseHex(hex)
    buf[i] = r
    buf[i + 1] = g
    buf[i + 2] = b
    buf[i + 3] = 255
  }

  /** Bresenham line — keeps pencil/eraser strokes continuous even when
   *  pointermove samples skip pixels (which happens whenever the user
   *  moves faster than one cell per event). */
  const writeLine = (
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    t: Tool,
    hex: string,
  ) => {
    let x = x0
    let y = y0
    const dx = Math.abs(x1 - x0)
    const dy = -Math.abs(y1 - y0)
    const sx = x0 < x1 ? 1 : -1
    const sy = y0 < y1 ? 1 : -1
    let err = dx + dy
    for (;;) {
      writePixel(x, y, t, hex)
      if (x === x1 && y === y1) break
      const e2 = 2 * err
      if (e2 >= dy) {
        err += dy
        x += sx
      }
      if (e2 <= dx) {
        err += dx
        y += sy
      }
    }
  }

  /** Flood-fill from (x,y) replacing every connected pixel that matches
   *  the seed's RGBA. Iterative — recursion blows the stack on 240×240. */
  const floodFill = (sx: number, sy: number, hex: string) => {
    const buf = pixelsRef.current
    const idx = (x: number, y: number) => (y * width + x) * 4
    const seedI = idx(sx, sy)
    const target = [buf[seedI], buf[seedI + 1], buf[seedI + 2], buf[seedI + 3]]
    const [r, g, b] = parseHex(hex)
    if (
      target[0] === r &&
      target[1] === g &&
      target[2] === b &&
      target[3] === 255
    ) {
      return
    }
    const visited = new Uint8Array(width * height)
    const stack: [number, number][] = [[sx, sy]]
    while (stack.length) {
      const [x, y] = stack.pop()!
      if (x < 0 || x >= width || y < 0 || y >= height) continue
      if (visited[y * width + x]) continue
      visited[y * width + x] = 1
      const i = idx(x, y)
      if (
        buf[i] !== target[0] ||
        buf[i + 1] !== target[1] ||
        buf[i + 2] !== target[2] ||
        buf[i + 3] !== target[3]
      ) {
        continue
      }
      buf[i] = r
      buf[i + 1] = g
      buf[i + 2] = b
      buf[i + 3] = 255
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1])
    }
  }

  const pickAt = (x: number, y: number) => {
    const i = (y * width + x) * 4
    const buf = pixelsRef.current
    if (buf[i + 3] === 0) return // skip transparent pixels — nothing to pick
    setColor(toHex(buf[i], buf[i + 1], buf[i + 2]))
    setTool('pencil')
  }

  /** True if (px, py) lies inside the given rect — half-open bounds. */
  const pointInRect = (
    px: number,
    py: number,
    r: SelectionRect,
  ): boolean =>
    px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h

  /** Snapshot the pixels under `r` into a floating buffer and erase the
   *  source area in the main buffer. Caller must `pushUndo()` first so
   *  the lift is reversible. No-op if a float already exists or `r` is
   *  outside the image. */
  const liftFloat = (r: SelectionRect) => {
    if (floatingRef.current) return
    const w = r.w
    const h = r.h
    if (w <= 0 || h <= 0) return
    const src = pixelsRef.current
    const lifted = new Uint8ClampedArray(w * h * 4)
    for (let row = 0; row < h; row++) {
      const sy = r.y + row
      if (sy < 0 || sy >= height) continue
      for (let col = 0; col < w; col++) {
        const sx = r.x + col
        if (sx < 0 || sx >= width) continue
        const si = (sy * width + sx) * 4
        const di = (row * w + col) * 4
        lifted[di] = src[si]
        lifted[di + 1] = src[si + 1]
        lifted[di + 2] = src[si + 2]
        lifted[di + 3] = src[si + 3]
        // Erase the source — leaves a transparent hole that the float
        // will fill on commit (potentially at a new location).
        src[si] = 0
        src[si + 1] = 0
        src[si + 2] = 0
        src[si + 3] = 0
      }
    }
    floatingRef.current = { rgba: lifted, w, h }
  }

  /** Composite the floating pixels back into the main buffer at the
   *  selection's current position (using standard source-over so the
   *  underlying pixels show through transparent parts of the float).
   *  Clears the float afterward. */
  const commitFloat = () => {
    const f = floatingRef.current
    const r = cropRectRef.current
    if (!f || !r) return
    const dest = pixelsRef.current
    for (let row = 0; row < f.h; row++) {
      const dy = r.y + row
      if (dy < 0 || dy >= height) continue
      for (let col = 0; col < f.w; col++) {
        const dx = r.x + col
        if (dx < 0 || dx >= width) continue
        const si = (row * f.w + col) * 4
        const sa = f.rgba[si + 3]
        if (sa === 0) continue
        const di = (dy * width + dx) * 4
        if (sa === 255) {
          dest[di] = f.rgba[si]
          dest[di + 1] = f.rgba[si + 1]
          dest[di + 2] = f.rgba[si + 2]
          dest[di + 3] = 255
          continue
        }
        // Standard source-over alpha blend.
        const da = dest[di + 3]
        const outA = sa + (da * (255 - sa)) / 255
        if (outA === 0) continue
        dest[di] =
          (f.rgba[si] * sa + (dest[di] * da * (255 - sa)) / 255) / outA
        dest[di + 1] =
          (f.rgba[si + 1] * sa + (dest[di + 1] * da * (255 - sa)) / 255) /
          outA
        dest[di + 2] =
          (f.rgba[si + 2] * sa + (dest[di + 2] * da * (255 - sa)) / 255) /
          outA
        dest[di + 3] = outA
      }
    }
    floatingRef.current = null
  }

  /** Commit the current selection — slice the pixel buffer to the rect
   *  and resize the editor to the new dimensions. Undoable. Any floating
   *  pixels are merged back at their current position first so the crop
   *  reflects the user's intended layout. */
  const applyCrop = () => {
    const r = cropRectRef.current
    if (!r) return
    const { x, y, w, h } = r
    if (w <= 0 || h <= 0) return
    pushUndo()
    commitFloat()
    const src = pixelsRef.current
    const next = new Uint8ClampedArray(w * h * 4)
    for (let row = 0; row < h; row++) {
      const sy = y + row
      if (sy < 0 || sy >= height) continue
      const srcOff = (sy * width + Math.max(0, x)) * 4
      const colStart = Math.max(0, -x)
      const colCount = Math.min(w - colStart, width - Math.max(0, x))
      if (colCount > 0) {
        next.set(
          src.subarray(srcOff, srcOff + colCount * 4),
          (row * w + colStart) * 4,
        )
      }
    }
    pixelsRef.current = next
    setDims({ w, h })
    setCropRect(null)
    setZoom((prev) => {
      const fit = initialZoom(w, h)
      if (prev * Math.max(w, h) < 120) return fit
      return Math.min(prev, MAX_ZOOM)
    })
    repaint()
  }

  /** Deselect — commits any floating pixels at their current position
   *  and clears the marquee. Use Cmd/Ctrl+Z to undo the move/lift. */
  const cancelCrop = () => {
    if (floatingRef.current) {
      commitFloat()
      repaint()
    }
    setCropRect(null)
  }

  applyCropRef.current = applyCrop

  /** Run a per-pixel transform across either the current selection or
   *  the whole image. Skips fully-transparent pixels (alpha=0) so the
   *  filter doesn't "fill in" empty space — eraser already handles
   *  the "make this pixel black" case explicitly. Single undo entry. */
  const applyFilter = (fn: (buf: Uint8ClampedArray, i: number) => void) => {
    pushUndo()
    const r = cropRectRef.current
    if (r && floatingRef.current) {
      // Float in flight — filter the lifted pixels in place.
      const f = floatingRef.current
      for (let i = 0; i < f.w * f.h; i++) {
        const off = i * 4
        if (f.rgba[off + 3] === 0) continue
        fn(f.rgba, off)
      }
    } else if (r) {
      const buf = pixelsRef.current
      const x0 = Math.max(0, r.x)
      const y0 = Math.max(0, r.y)
      const x1 = Math.min(width, r.x + r.w)
      const y1 = Math.min(height, r.y + r.h)
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const off = (y * width + x) * 4
          if (buf[off + 3] === 0) continue
          fn(buf, off)
        }
      }
    } else {
      const buf = pixelsRef.current
      const total = width * height
      for (let i = 0; i < total; i++) {
        const off = i * 4
        if (buf[off + 3] === 0) continue
        fn(buf, off)
      }
    }
    repaint()
  }

  /** Tone filters — each mutates rgba[i..i+3] in place. Alpha untouched
   *  so transparent pixels stay transparent. */
  type FilterEntry = {
    id: string
    label: string
    title: string
    fn: (buf: Uint8ClampedArray, i: number) => void
  }
  const TONE_FILTERS: FilterEntry[] = [
    {
      id: 'invert',
      label: 'Invert',
      title: 'Invert RGB',
      fn: (b, i) => {
        b[i] = 255 - b[i]
        b[i + 1] = 255 - b[i + 1]
        b[i + 2] = 255 - b[i + 2]
      },
    },
    {
      id: 'grayscale',
      label: 'Gray',
      title: 'Grayscale (BT.601 luma)',
      fn: (b, i) => {
        const y = Math.round(
          0.299 * b[i] + 0.587 * b[i + 1] + 0.114 * b[i + 2],
        )
        b[i] = y
        b[i + 1] = y
        b[i + 2] = y
      },
    },
    {
      id: 'threshold',
      label: '1-bit',
      title: 'Threshold to black & white (mid-grey cutoff)',
      fn: (b, i) => {
        const y = 0.299 * b[i] + 0.587 * b[i + 1] + 0.114 * b[i + 2]
        const v = y >= 128 ? 255 : 0
        b[i] = v
        b[i + 1] = v
        b[i + 2] = v
      },
    },
    {
      id: 'quantize565',
      label: 'RGB565',
      title:
        'Quantize to RGB565 — preview the exact colours the encoder will ship',
      fn: (b, i) => {
        // Round-trip through 5-6-5: mask the low bits and replicate the
        // top bits down so the encoder's input is its own output.
        b[i] = (b[i] & 0xf8) | (b[i] >> 5)
        b[i + 1] = (b[i + 1] & 0xfc) | (b[i + 1] >> 6)
        b[i + 2] = (b[i + 2] & 0xf8) | (b[i + 2] >> 5)
      },
    },
  ]

  /** Channel swaps — `dest[out]` = which input channel feeds output
   *  position `out` (0=R, 1=G, 2=B). The button visualises this by
   *  painting three coloured cells in the destination order. */
  type SwapEntry = {
    id: string
    label: string
    title: string
    dest: [number, number, number]
  }
  const SWAPS: SwapEntry[] = [
    {
      id: 'swap-rb',
      label: 'R↔B',
      title: 'Swap red and blue channels',
      dest: [2, 1, 0],
    },
    {
      id: 'rotate-rgb',
      label: 'R→G→B',
      title: 'Rotate forward: R→G→B→R',
      dest: [2, 0, 1],
    },
    {
      id: 'rotate-bgr',
      label: 'B→G→R',
      title: 'Rotate reverse: R→B→G→R',
      dest: [1, 2, 0],
    },
  ]

  const applySwap = (dest: [number, number, number]) => {
    applyFilter((b, i) => {
      const r = b[i]
      const g = b[i + 1]
      const bl = b[i + 2]
      const src = [r, g, bl] as const
      b[i] = src[dest[0]]
      b[i + 1] = src[dest[1]]
      b[i + 2] = src[dest[2]]
    })
  }

  // ----- Channel intensity sliders ------------------------------------
  // Sliders hold *pending* per-channel scale percentages (-100..+100).
  // The preview is computed on-the-fly during canvas paint so the user
  // sees the proposed change live, but `pixelsRef` only changes when
  // they click "Apply" — that's a single undo step. "Reset" just zeroes
  // the sliders without touching the buffer.
  //
  // Multiplicative semantics (not additive): out = clamp(in × (1 + p/100)).
  // This preserves black (0 × anything = 0), which matches users'
  // expectation that the watch's "off" pixel doesn't tint. Additive
  // would turn black into a coloured pixel — surprising and rarely
  // what you want.
  const [channelOffsets, setChannelOffsets] = useState<
    readonly [number, number, number]
  >([0, 0, 0])
  const hasChannelOffsets =
    channelOffsets[0] !== 0 ||
    channelOffsets[1] !== 0 ||
    channelOffsets[2] !== 0

  /** Apply per-channel scale to a source buffer, returning a new
   *  buffer. Respects the active selection / float scope. Transparent
   *  pixels are skipped so empty canvas stays transparent. */
  const computeOffsetPreview = (
    src: Uint8ClampedArray,
    offsets: readonly [number, number, number],
    floatScope: boolean,
  ): Uint8ClampedArray => {
    const out = new Uint8ClampedArray(src)
    const scales: [number, number, number] = [
      1 + offsets[0] / 100,
      1 + offsets[1] / 100,
      1 + offsets[2] / 100,
    ]
    const adjust = (off: number) => {
      if (out[off + 3] === 0) return
      for (let c = 0; c < 3; c++) {
        const s = scales[c]
        if (s === 1) continue
        const v = Math.round(src[off + c] * s)
        out[off + c] = v < 0 ? 0 : v > 255 ? 255 : v
      }
    }
    if (floatScope) {
      // Float buffer is passed in directly; iterate every pixel.
      const total = out.length / 4
      for (let i = 0; i < total; i++) adjust(i * 4)
      return out
    }
    const r = cropRectRef.current
    if (r && !floatingRef.current) {
      const x0 = Math.max(0, r.x)
      const y0 = Math.max(0, r.y)
      const x1 = Math.min(width, r.x + r.w)
      const y1 = Math.min(height, r.y + r.h)
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) adjust((y * width + x) * 4)
      }
      return out
    }
    const total = width * height
    for (let i = 0; i < total; i++) adjust(i * 4)
    return out
  }

  const applyChannelOffsets = () => {
    if (!hasChannelOffsets) return
    pushUndo()
    if (floatingRef.current) {
      const f = floatingRef.current
      f.rgba = computeOffsetPreview(f.rgba, channelOffsets, true)
    } else {
      pixelsRef.current = computeOffsetPreview(
        pixelsRef.current,
        channelOffsets,
        false,
      )
    }
    setChannelOffsets([0, 0, 0])
    repaint()
  }

  const resetChannelOffsets = () => setChannelOffsets([0, 0, 0])

  const clearAll = () => {
    if (
      !window.confirm(
        'Clear all pixels? You can still undo with Cmd/Ctrl+Z afterward.',
      )
    ) {
      return
    }
    pushUndo()
    pixelsRef.current = new Uint8ClampedArray(width * height * 4)
    repaint()
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0) return
    const px = clientToPixel(e.clientX, e.clientY)
    if (!px) return
    pointerRef.current.activeTool = tool
    if (tool === 'select') {
      const current = cropRectRef.current
      if (current && pointInRect(px.x, px.y, current)) {
        // Drag started inside the existing selection → move it. Lift
        // the pixels once at drag start so undo captures the original
        // layout in one entry. The float position tracks the rect.
        pushUndo()
        liftFloat(current)
        dragRef.current = {
          kind: 'move',
          mouseStartX: px.x,
          mouseStartY: px.y,
          rectStartX: current.x,
          rectStartY: current.y,
        }
        e.currentTarget.setPointerCapture(e.pointerId)
        repaint()
        return
      }
      // Drag started outside any selection → start a fresh marquee.
      // Commit any floating pixels first so they don't get orphaned.
      if (floatingRef.current) {
        commitFloat()
        repaint()
      }
      dragRef.current = { kind: 'select', startX: px.x, startY: px.y }
      setCropRect({ x: px.x, y: px.y, w: 1, h: 1 })
      e.currentTarget.setPointerCapture(e.pointerId)
      return
    }
    // Painting tools — if there's a floating selection, commit it before
    // any paint stroke so the strokes don't erase the user's move.
    if (floatingRef.current) {
      commitFloat()
      setCropRect(null)
      repaint()
    }
    pushUndo()
    if (tool === 'eye') {
      pickAt(px.x, px.y)
      repaint()
      return
    }
    if (tool === 'bucket') {
      floodFill(px.x, px.y, color)
      repaint()
      return
    }
    // Pencil / Eraser: start a stroke.
    writePixel(px.x, px.y, tool, color)
    pointerRef.current.isDown = true
    pointerRef.current.lastX = px.x
    pointerRef.current.lastY = px.y
    repaint()
    e.currentTarget.setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    if (drag) {
      // Marquee + move both want pointer coords even outside the image,
      // so we clamp here rather than using clientToPixel's early-return.
      const c = canvasRef.current
      if (!c) return
      const rect = c.getBoundingClientRect()
      const rawX = Math.floor(((e.clientX - rect.left) * width) / rect.width)
      const rawY = Math.floor(((e.clientY - rect.top) * height) / rect.height)
      if (drag.kind === 'select') {
        const px = Math.max(0, Math.min(width - 1, rawX))
        const py = Math.max(0, Math.min(height - 1, rawY))
        const x = Math.min(drag.startX, px)
        const y = Math.min(drag.startY, py)
        const w = Math.abs(px - drag.startX) + 1
        const h = Math.abs(py - drag.startY) + 1
        setCropRect({ x, y, w, h })
        return
      }
      // kind === 'move' — translate the rect by (mouseDelta).
      const dx = rawX - drag.mouseStartX
      const dy = rawY - drag.mouseStartY
      setCropRect((r) => {
        if (!r) return r
        return { ...r, x: drag.rectStartX + dx, y: drag.rectStartY + dy }
      })
      repaint()
      return
    }
    if (!pointerRef.current.isDown) return
    const t = pointerRef.current.activeTool
    if (t !== 'pencil' && t !== 'eraser') return
    const px = clientToPixel(e.clientX, e.clientY)
    if (!px) return
    if (px.x === pointerRef.current.lastX && px.y === pointerRef.current.lastY) {
      return
    }
    writeLine(
      pointerRef.current.lastX,
      pointerRef.current.lastY,
      px.x,
      px.y,
      t,
      color,
    )
    pointerRef.current.lastX = px.x
    pointerRef.current.lastY = px.y
    repaint()
  }

  const endStroke = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    if (drag) {
      dragRef.current = null
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId)
      }
      if (drag.kind === 'select') {
        // Discard zero-area selections (single click without drag).
        setCropRect((r) => (r && r.w > 0 && r.h > 0 ? r : null))
      }
      // Move drags leave both the rect and the float in place so the
      // user can fine-tune with another drag before committing.
      return
    }
    if (!pointerRef.current.isDown) return
    pointerRef.current.isDown = false
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId)
    }
  }

  const doSave = () => {
    // Commit any pending move so the saved bytes reflect what the
    // user sees on canvas.
    if (floatingRef.current) commitFloat()
    onSave(new Uint8ClampedArray(pixelsRef.current), width, height)
  }

  /** Switch tools. Leaving the select tool commits any floating pixels
   *  at their current position and clears the marquee so the dimmed
   *  overlay doesn't hang around while painting. */
  const chooseTool = (t: Tool) => {
    if (t !== 'select') {
      if (floatingRef.current) commitFloat()
      setCropRect(null)
    }
    setTool(t)
  }

  const zoomIn = () => setZoom((z) => Math.min(MAX_ZOOM, z + (z < 8 ? 1 : 2)))
  const zoomOut = () =>
    setZoom((z) => Math.max(MIN_ZOOM, z - (z <= 8 ? 1 : 2)))

  const cursorClass = useMemo(() => {
    switch (tool) {
      case 'pencil':
        return 'cursor-pencil'
      case 'eraser':
        return 'cursor-eraser'
      case 'bucket':
        return 'cursor-bucket'
      case 'eye':
        return 'cursor-eye'
      case 'select':
        return 'cursor-select'
    }
  }, [tool])

  const renderedW = width * zoom
  const renderedH = height * zoom

  return createPortal(
    <div className="pixel-editor-wrap">
      <header className="pixel-editor-head">
        <Tooltip content={name} placement="bottom">
          <h2>{name}</h2>
        </Tooltip>
        <span className="pixel-editor-dims">
          {width}×{height}
        </span>
        <button
          type="button"
          className="modal-close"
          onClick={onClose}
          aria-label="Close editor"
        >
          <X size={20} />
        </button>
      </header>

      <div className="pixel-editor-body">
        <aside className="pixel-editor-tools" aria-label="Tools">
          <Tooltip content="Pencil (P)" placement="right">
            <button
              type="button"
              className={`pixel-tool${tool === 'pencil' ? ' active' : ''}`}
              onClick={() => chooseTool('pencil')}
            >
              <Pencil size={16} aria-hidden />
            </button>
          </Tooltip>
          <Tooltip
            content={'Eraser → black (E)\nRGB565 has no alpha; erased pixels ship as black'}
            placement="right"
          >
            <button
              type="button"
              className={`pixel-tool${tool === 'eraser' ? ' active' : ''}`}
              onClick={() => chooseTool('eraser')}
            >
              <Eraser size={16} aria-hidden />
            </button>
          </Tooltip>
          <Tooltip content="Bucket fill (B)" placement="right">
            <button
              type="button"
              className={`pixel-tool${tool === 'bucket' ? ' active' : ''}`}
              onClick={() => chooseTool('bucket')}
            >
              <PaintBucket size={16} aria-hidden />
            </button>
          </Tooltip>
          <Tooltip content="Eyedropper (I)" placement="right">
            <button
              type="button"
              className={`pixel-tool${tool === 'eye' ? ' active' : ''}`}
              onClick={() => chooseTool('eye')}
            >
              <Pipette size={16} aria-hidden />
            </button>
          </Tooltip>
          <Tooltip
            content={'Select / move / crop (C)\nDrag to mark, drag inside to move'}
            placement="right"
          >
            <button
              type="button"
              className={`pixel-tool${tool === 'select' ? ' active' : ''}`}
              onClick={() => chooseTool('select')}
            >
              <BoxSelect size={16} aria-hidden />
            </button>
          </Tooltip>

          <span className="pixel-tool-sep" aria-hidden />

          <Tooltip content={"Undo\nCmd/Ctrl+Z"} placement="right">
            <button
              type="button"
              className="pixel-tool"
              onClick={doUndo}
              disabled={!canUndo}
            >
              <Undo2 size={16} aria-hidden />
            </button>
          </Tooltip>
          <Tooltip content={"Redo\nCmd/Ctrl+Shift+Z"} placement="right">
            <button
              type="button"
              className="pixel-tool"
              onClick={doRedo}
              disabled={!canRedo}
            >
              <Redo2 size={16} aria-hidden />
            </button>
          </Tooltip>

          <span className="pixel-tool-sep" aria-hidden />

          <Tooltip content="Clear all" placement="right">
            <button
              type="button"
              className="pixel-tool"
              onClick={clearAll}
            >
              <Trash2 size={16} aria-hidden />
            </button>
          </Tooltip>
        </aside>

        <div className="pixel-editor-canvas">
          <div
            className="pixel-canvas-viewport"
            style={{ '--checker': '10px' } as React.CSSProperties}
          >
            <div
              className={`pixel-canvas-stack ${cursorClass}`}
              style={{ width: renderedW, height: renderedH }}
            >
              <canvas
                ref={canvasRef}
                className="pixel-canvas-image"
                width={width}
                height={height}
                style={{ width: renderedW, height: renderedH }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endStroke}
                onPointerCancel={endStroke}
              />
              <canvas
                ref={gridRef}
                className="pixel-canvas-grid"
                aria-hidden
              />
              {cropRect && (
                <div
                  className="pixel-crop-rect"
                  aria-hidden
                  style={{
                    left: cropRect.x * zoom,
                    top: cropRect.y * zoom,
                    width: cropRect.w * zoom,
                    height: cropRect.h * zoom,
                  }}
                />
              )}
            </div>
          </div>

          <div className="pixel-canvas-footer">
            {cropRect && (
              <div
                className="pixel-crop-bar"
                role="group"
                aria-label="Selection"
              >
                <span className="pixel-crop-dims">
                  {cropRect.w}×{cropRect.h} @ {cropRect.x},{cropRect.y}
                </span>
                <button
                  type="button"
                  className="counter ghost"
                  onClick={cancelCrop}
                >
                  Deselect
                </button>
                <button
                  type="button"
                  className="counter"
                  onClick={applyCrop}
                >
                  <Check size={14} aria-hidden />
                  Crop to selection
                </button>
              </div>
            )}
            <div className="pixel-zoom" role="group" aria-label="Zoom">
              <Tooltip content="Zoom out">
                <button
                  type="button"
                  className="pixel-tool"
                  onClick={zoomOut}
                  disabled={zoom <= MIN_ZOOM}
                >
                  <ZoomOut size={14} aria-hidden />
                </button>
              </Tooltip>
              <span className="pixel-zoom-label">{zoom}×</span>
              <Tooltip content="Zoom in">
                <button
                  type="button"
                  className="pixel-tool"
                  onClick={zoomIn}
                  disabled={zoom >= MAX_ZOOM}
                >
                  <ZoomIn size={14} aria-hidden />
                </button>
              </Tooltip>
              <Tooltip content="Toggle grid">
                <button
                  type="button"
                  className={`pixel-tool${showGrid ? ' active' : ''}`}
                  onClick={() => setShowGrid((v) => !v)}
                  disabled={zoom < 8}
                >
                  <Grid3x3 size={14} aria-hidden />
                </button>
              </Tooltip>
            </div>
          </div>
        </div>

        <aside className="pixel-editor-colors" aria-label="Colors">
          <label className="pixel-color-current">
            <span className="pixel-color-swatch" style={{ background: color }} />
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              aria-label="Pick custom colour"
            />
            <code>{color.toUpperCase()}</code>
          </label>

          <div className="pixel-color-presets">
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                className={`pixel-color-preset${
                  color.toLowerCase() === p ? ' active' : ''
                }`}
                style={{ background: p }}
                aria-label={`Set colour ${p}`}
                onClick={() => setColor(p)}
              />
            ))}
          </div>

          <div
            className="pixel-filters"
            role="group"
            aria-label={
              cropRect ? 'Filters (selection only)' : 'Filters (whole image)'
            }
          >
            <div className="pixel-filters-head">
              <span>Tone</span>
              <span className="pixel-filters-scope">
                {cropRect ? 'selection' : 'whole image'}
              </span>
            </div>
            <div className="pixel-filters-grid">
              {TONE_FILTERS.map((f) => (
                <Tooltip key={f.id} content={f.title} placement="left">
                  <button
                    type="button"
                    className="pixel-filter-btn"
                    onClick={() => applyFilter(f.fn)}
                  >
                    {f.label}
                  </button>
                </Tooltip>
              ))}
            </div>

            <div className="pixel-filters-head">
              <span>Channel swap</span>
            </div>
            <div className="pixel-swaps">
              {SWAPS.map((s) => (
                <Tooltip key={s.id} content={s.title} placement="left">
                  <button
                    type="button"
                    className="pixel-swap-btn"
                    onClick={() => applySwap(s.dest)}
                  >
                    <span className="pixel-swap-bar" aria-hidden>
                      {s.dest.map((srcCh, outIdx) => (
                        <span
                          key={outIdx}
                          className={`pixel-swap-cell ch-${srcCh}`}
                        >
                          {['R', 'G', 'B'][srcCh]}
                        </span>
                      ))}
                    </span>
                    <span className="pixel-swap-label">{s.label}</span>
                  </button>
                </Tooltip>
              ))}
            </div>

            <div className="pixel-filters-head">
              <span>Channels</span>
            </div>
            <div className="pixel-channel-sliders">
              {(['R', 'G', 'B'] as const).map((label, ch) => {
                const v = channelOffsets[ch]
                return (
                  <div
                    key={label}
                    className={`pixel-channel-row ch-${ch}`}
                  >
                    <span className="pixel-channel-label">{label}</span>
                    <input
                      type="range"
                      className="pixel-channel-slider"
                      min={-100}
                      max={100}
                      step={1}
                      value={v}
                      onChange={(e) => {
                        const next = Number(e.target.value)
                        setChannelOffsets((o) => {
                          const out: [number, number, number] = [...o]
                          out[ch] = next
                          return out
                        })
                      }}
                      aria-label={`${label} channel intensity`}
                    />
                    <span className="pixel-channel-value">
                      {v > 0 ? `+${v}%` : `${v}%`}
                    </span>
                  </div>
                )
              })}
              <div className="pixel-channel-actions">
                <button
                  type="button"
                  className="pixel-filter-btn"
                  onClick={resetChannelOffsets}
                  disabled={!hasChannelOffsets}
                >
                  Reset
                </button>
                <button
                  type="button"
                  className="pixel-filter-btn primary"
                  onClick={applyChannelOffsets}
                  disabled={!hasChannelOffsets}
                >
                  Apply
                </button>
              </div>
            </div>
          </div>
        </aside>
      </div>

      <footer className="pixel-editor-foot">
        <button type="button" className="counter ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="counter" onClick={doSave}>
          <Check size={14} aria-hidden />
          Save
        </button>
      </footer>
    </div>,
    document.body,
  )
}

export default BmpPixelEditor
