<script setup>
defineProps(["size", "color"]);
</script>

<template>
  <div class="lds-ring" :style="{ width: size + 'px', height: size + 'px' }">
    <div
      :style="{
        width: size - 6 + 'px',
        height: size - 6 + 'px',
        borderColor: color + ' transparent transparent transparent',
      }"
    ></div>
    <div
      :style="{
        width: size - 6 + 'px',
        height: size - 6 + 'px',
        borderColor: color + ' transparent transparent transparent',
      }"
    ></div>
    <div
      :style="{
        width: size - 6 + 'px',
        height: size - 6 + 'px',
        borderColor: color + ' transparent transparent transparent',
      }"
    ></div>
  </div>
</template>

<style scoped>
.lds-ring {
  display: inline-block;
  position: relative;
}
.lds-ring div {
  box-sizing: border-box;
  display: block;
  position: absolute;
  border: 3px solid #fff;
  margin: 2px;
  border-radius: 50%;
  animation: lds-ring 1.2s cubic-bezier(0.5, 0, 0.5, 1) infinite;
  border-color: #fff transparent transparent transparent;
}
.lds-ring div:nth-child(1) {
  animation-delay: -0.45s;
}
.lds-ring div:nth-child(2) {
  animation-delay: -0.3s;
}
.lds-ring div:nth-child(3) {
  animation-delay: -0.15s;
}
@keyframes lds-ring {
  0% {
    transform: rotate(0deg);
  }
  100% {
    transform: rotate(360deg);
  }
}
</style>
