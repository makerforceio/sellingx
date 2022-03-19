<script setup>
// This starter template is using Vue 3 <script setup> SFCs
// Check out https://v3.vuejs.org/api/sfc-script-setup.html#sfc-script-setup
import Home from "./components/Home.vue";
</script>

<template>
  <div class="w-full lg:w-8/12 p-6 mx-auto">
    <Home />
  </div>
  
  <!-- Footer -->
  <footer class="flex flex-col justify-center items-center text-gray-900 w-full px-4 pb-8 absolute inset-x-0 bottom-0">
  <span class="text-sm">Designed and built with <div class="heart">❤️ </div> by 
    <a class="underline underline-offset-1 hover:underline-offset-2 hover:text-red-500" href="https://www.google.com/">Shan</a> and 
    <a class="underline underline-offset-1 hover:underline-offset-2 hover:text-red-500" href="https://www.google.com/">Daniel</a>.
  </span>
    <div class="flex flex-row my-2">
      <a href="https://www.google.com/" class="text-xs mx-2">Terms of Use</a>
      <a href="https://www.google.con/" class="text-xs mx-2">Privacy Policy</a>
    </div>
  </footer>
</template>

<style>
</style>
