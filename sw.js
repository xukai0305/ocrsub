// PaddleOCR 모델(수십 MB)과 onnxruntime-web wasm을 한 번 받으면 이 브라우저에 계속 저장해 두고 재사용한다.
// 이 파일들은 Web Worker 안에서 fetch되는데, 워커 모드에서는 커스텀 fetch 함수를 못 넘겨주기 때문에
// (라이브러리가 명시적으로 막아둠) 앱 코드로는 캐싱을 못 하고, 이렇게 네트워크 계층에서 가로채는
// 서비스워커로 처리한다. 페이지를 새로고침해도, 다른 영상을 열어도 이 캐시는 그대로 남아 있다.

const CACHE_NAME = 'paddleocr-assets-v2'
// 이 호스트로 가는 요청만 캐시 대상으로 삼는다 (모델 파일 + onnxruntime wasm/js).
// bcebos.com = PaddleOCR 공식 모델 CDN(중국), cdn.jsdelivr.net = onnxruntime-web wasm.
// * GitHub(raw.githubusercontent.com / github.com)은 일부러 뺐다 — 서비스워커가 이 두 호스트로 가는
//   요청을 가로채서 재요청하면 이유를 알 수 없는 CORS 에러가 계속 나서(정작 GitHub 응답 자체엔
//   Access-Control-Allow-Origin: * 가 정상적으로 들어있는데도), 여러 방법으로도 해결이 안 됐다.
//   그래서 GitHub 쪽 파일은 서비스워커를 거치지 않고 브라우저가 알아서 직접 받아가게 그냥 둔다
//   (그래도 GitHub는 응답이 빠른 CDN이라 매번 크게 오래 걸리진 않는다 — 다만 브라우저 기본 HTTP
//   캐시만 쓰게 되어 bcebos.com/jsdelivr처럼 영구 캐시는 아니고, GitHub가 보내는
//   cache-control(약 5분)만큼만 짧게 캐시된다).
const CACHEABLE_HOSTS = ['bcebos.com', 'cdn.jsdelivr.net']

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
  const url = request.url

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME)
    // 캐시 키는 url 문자열로 통일한다 (아래에서 새로 만드는 요청과 짝이 맞아야 cache.match가 찾는다).
    const cached = await cache.match(url)
    if (cached) return cached
    try {
      // 원본 request 객체를 그대로 fetch()에 넘기지 않고, url 문자열만 가지고 새 요청을 만든다.
      // 원본 request는 PaddleOCR 워커(별도 스레드) 안에서 만들어진 건데, 그 안에 담긴 mode/credentials
      // 값을 서비스워커가 그대로 이어받아 재요청하면 (둘 다 정상 값이어도) 왜인지 cross-origin
      // 요청이 CORS 에러로 막히는 경우가 있었다 (raw.githubusercontent.com은 Access-Control-Allow-Origin: *
      // 를 정상적으로 보내는데도 막혔다). url 문자열만으로 새로 fetch하면 기본값(mode: 'cors',
      // credentials: 'same-origin')으로 깨끗하게 다시 요청하게 되어 이 문제를 피할 수 있다.
      const response = await fetch(url)
      // 응답이 정상이면(불완전/에러 응답은 캐시하지 않음) 다음번을 위해 저장해 둔다.
      if (response && response.ok) cache.put(url, response.clone())
      return response
    } catch (err) {
      // 네트워크 실패 시, 혹시 예전에 받아둔 게 있으면 그거라도 준다.
      const fallback = await cache.match(url)
      if (fallback) return fallback
      throw err
    }
  })())
})
