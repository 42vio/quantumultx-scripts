// Save reusable native universalSign requests locally; never log credentials.
try {
  if (/^https:\/\/ccsp-egmas\.sf-express\.com\/cx-app-member\/member\/app\/user\/universalSign(?:\?[^#]*)?$/.test($request.url) &&
      $request.method === 'POST' && typeof $request.body === 'string') {
    const request = { url: $request.url, method: $request.method, headers: $request.headers || {}, body: $request.body }
    const value = name => {
      const key = Object.keys(request.headers).find(key => key.toLowerCase() === name)
      return key ? request.headers[key] : ''
    }
    const token = value('token')
    if (token && JSON.stringify(request).length <= 128 * 1024) {
      let samples
      try { samples = JSON.parse($prefs.valueForKey('sfexpress_native_requests')) } catch (_) {}
      if (!Array.isArray(samples)) samples = []
      samples = samples.filter(sample => {
        const headers = sample.request && sample.request.headers || {}
        const key = Object.keys(headers).find(key => key.toLowerCase() === 'token')
        return !key || headers[key] !== token
      })
      samples.push({ at: Date.now(), request })
      const saved = $prefs.setValueForKey(JSON.stringify(samples.slice(-10)), 'sfexpress_native_requests')
      $notify('顺丰速运', saved ? 'App 换票请求已保存' : 'App 换票请求保存失败', '进入积分签到页后再运行任务；退出登录可能使原生登录态失效')
    }
  }
} catch (_) {
  $notify('顺丰速运', 'App 换票请求保存失败', '未输出凭据，原流量继续放行')
}
$done({})
