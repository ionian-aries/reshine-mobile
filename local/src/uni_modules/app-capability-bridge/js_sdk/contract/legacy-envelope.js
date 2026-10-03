export const legacySuccess = (data = {}, message = '') => ({ status: 'success', code: 'OK', message, data })

export const legacyFailure = (code, message, data = {}, status = 'error') => ({
  status: status === 'unsupported' ? 'unsupported' : 'error',
  code,
  message,
  data,
})