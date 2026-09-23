<template>
  <app-capability-bridge-shell :src="webviewUrl" />
</template>

<script>
export default {
  data: () => ({
    webviewUrl: process.env.VUE_APP_WEBVIEW_URL,
  }),
};
</script>
