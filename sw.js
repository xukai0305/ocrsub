// PaddleOCR 모델(수십 MB)과 onnxruntime-web wasm을 한 번 받으면 이 브라우저에 계속 저장해 두고 재사용한다.
// 이 파일들은 Web Worker 안에서 fetch되는데, 워커 모드에서는 커스텀 fetch 함수를 못 넘겨주기 때문에
// (라이브러리가 명시적으로 막아둠) 앱 코드로는 캐싱을 못 하고, 이렇게 네트워크 계층에서 가로채는
// 서비스워커로 처리한다. 페이지를 새로고침해도, 다른 영상을 열어도 이 캐시는 그대로 남아 있다.

const CACHE_NAME = 'paddleocr-assets-v1'
// 이 호스트로 가는 요청만 캐시 대상으로 삼는다 (모델 파일 + onnxruntime wasm/js).
// bcebos.com = PaddleOCR 공식 모델 CDN(중국), cdn.jsdelivr.net = onnxruntime-web wasm 및
// (자체 호스팅 시) jsDelivr의 GitHub 프록시(cdn.jsdelivr.net/gh/...), raw.githubusercontent.com =
// 모델을 GitHub 저장소에 직접 올려 raw로 받는 경우, github.com = GitHub Releases에 첨부파일로
// 올린 경우(주소가 github.com/사용자/저장소/releases/download/... 형태라서 필요).
const CACHEABLE_HOSTS = ['bcebos.com', 'cdn.jsdelivr.net', 'raw.githubusercontent.com', 'github.com']

// 사용자가 앱을 열자마자(=OCR 영역을 지정하기 한참 전에) 백그라운드로 미리 받아둔다.
// 이렇게 해두면 첫 PaddleOCR 사용 시점에도 이미 캐시가 채워져 있어서 대기 시간이 크게 줄어든다.
// PP-OCRv5(lang: 'ch')가 실제로 쓰는 mobile det/rec 모델 URL이다 — paddleOcr.ts의 엔진 설정이
// 바뀌면(다른 버전/모델을 쓰게 되면) 이 목록도 같이 바꿔줘야 한다.
const PRECACHE_URLS = [
  'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv5_mobile_det_onnx_infer.tar',
  'https://paddle-model-ecology.bj.bcebos.com/paddlex/official_inference_model/paddle3.0.0/PP-OCRv5_mobile_rec_onnx_infer.tar',
]

self.addEventListener('install', (event) => {
  self.skipWaiting()
  // 프리캐시는 install을 막지 않는다 — 실패해도(네트워크 문제 등) 설치 자체는 그대로 진행되고,
  // 어차피 fetch 핸들러가 첫 실제 요청 때 다시 캐시를 채워준다.
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME)
    await Promise.all(PRECACHE_URLS.map(async (url) => {
      try {
        const existing = await cache.match(url)
        if (existing) return
        const response = await fetch(url)
        if (response && response.ok) await cache.put(url, response)
      } catch { /* 네트워크 문제 등으로 실패해도 무시 — 나중에 fetch 핸들러가 다시 시도한다 */ }
    }))
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

function isCacheable(url) {
  try {
    const host = new URL(url).hostname
    return CACHEABLE_HOSTS.some((h) => host.endsWith(h))
  } catch {
    return false
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event
  if (request.method !== 'GET' || !isCacheable(request.url)) return

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME)
    const cached = await cache.match(request)
    if (cached) return cached
    try {
      const response = await fetch(request)
      // 응답이 정상이면(불완전/에러 응답은 캐시하지 않음) 다음번을 위해 저장해 둔다.
      if (response && response.ok) cache.put(request, response.clone())
      return response
    } catch (err) {
      // 네트워크 실패 시, 혹시 예전에 받아둔 게 있으면 그거라도 준다.
      const fallback = await cache.match(request)
      if (fallback) return fallback
      throw err
    }
  })())
})
