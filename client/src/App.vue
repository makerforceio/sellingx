<script setup>
// This starter template is using Vue 3 <script setup> SFCs
// Check out https://v3.vuejs.org/api/sfc-script-setup.html#sfc-script-setup
import Home from "./components/Home.vue";
</script>

<template>
  <div class="flex flex-col h-full">
    <div class="w-full lg:w-8/12 p-6 mx-auto grow">
      <Home />
    </div>
    
    <!-- Footer -->
    <footer class="flex flex-col shrink-0 justify-center items-center text-gray-900 w-full px-4 pb-4 lg:pb-8">
    <span class="text-sm">Designed and built with <span class="heart">❤️ </span> by 
      <a class="underline underline-offset-1 hover:underline-offset-2 hover:text-red-500" href="https://solderneer.me/">Shan</a> and 
      <a class="underline underline-offset-1 hover:underline-offset-2 hover:text-red-500" href="https://instagram.com/octal.orca">Daniel</a>.
    </span>
      <div class="flex flex-row my-2">
        <span class="text-xs">Need help? Contact us at
          <a href="mailto:support@sellingx.io?subject=Support%20Request" class="underline underline-offset-1 hover:underline-offset-2 hover:text-red-500">support@sellingx.io</a>
        </span>
      </div>
    </footer>
  </div>
</template>

<style>
</style>
