export enum EVENT {
  COPY = 'copy',
  PASTE = 'paste',
  CUT = 'cut',
  KEYDOWN = 'keydown',
  KEYUP = 'keyup',
  MOUSE_MOVE = 'mousemove',
  RESIZE = 'resize',
  UNLOAD = 'unload',
  FOCUS = 'focus',
  BLUR = 'blur',
  DRAG_OVER = 'dragover',
  DROP = 'drop',
  GESTURE_END = 'gestureend',
  BEFORE_UNLOAD = 'beforeunload',
  GESTURE_START = 'gesturestart',
  GESTURE_CHANGE = 'gesturechange',
  POINTER_MOVE = 'pointermove',
  POINTER_DOWN = 'pointerdown',
  POINTER_UP = 'pointerup',
  STATE_CHANGE = 'statechange',
  WHEEL = 'wheel',
  TOUCH_START = 'touchstart',
  TOUCH_END = 'touchend',
  HASHCHANGE = 'hashchange',
  VISIBILITY_CHANGE = 'visibilitychange',
  SCROLL = 'scroll',
  MENU_ITEM_SELECT = 'menu.itemSelect',
  MESSAGE = 'message',
  FULLSCREENCHANGE = 'fullscreenchange',
}

export const IMAGE_MIME_TYPES = {
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
  avif: "image/avif",
  jfif: "image/jfif",
} as const;

export const MIME_TYPES = {
  json: 'application/json',
  drawnix: 'application/vnd.drawnix+json',
  // image
  ...IMAGE_MIME_TYPES,
} as const;

export const VERSIONS = {
  drawnix: 1,
  app: '0.2.1',
} as const;

// 自部署 Feedbackland 实例地址（侧边栏反馈按钮的跳转目标）
// Feedbackland 开源项目：https://github.com/feedbackland/feedbackland
// 已容器化部署到越秀宿主机（见 deploy/feedbackland/ 与 release.yml deploy job）；
// 如需更换实例地址，只改这一处即可。
export const FEEDBACKLAND_URL = 'http://10.37.80.25:8090';
