<template>
  <div class="notFound">
    <div class="notFoundContent">
      <span class="notFoundCode">
        <svg class="face" viewBox="0 0 320 380" width="320px" height="380px" aria-label="404 数字变成一张脸，左右张望并眨眼，嘴角画出微笑。">
          <g fill="none" stroke="currentcolor" stroke-linecap="round" stroke-linejoin="round" stroke-width="25">
            <g class="faceEyes" transform="translate(0, 112.5)">
              <g transform="translate(15, 0)">
                <polyline class="faceEyeLid" points="37,0 0,120 75,120" />
                <polyline class="facePupil" points="55,120 55,155" stroke-dasharray="35 35" />
              </g>
              <g transform="translate(230, 0)">
                <polyline class="faceEyeLid" points="37,0 0,120 75,120" />
                <polyline class="facePupil" points="55,120 55,155" stroke-dasharray="35 35" />
              </g>
            </g>
            <rect class="faceNose" rx="4" ry="4" x="132.5" y="112.5" width="55" height="155" />
            <g stroke-dasharray="102 102" transform="translate(65, 334)">
              <path class="faceMouthLeft" d="M 0 30 C 0 30 40 0 95 0" stroke-dashoffset="-102" />
              <path class="faceMouthRight" d="M 95 0 C 150 0 190 30 190 30" stroke-dashoffset="102" />
            </g>
          </g>
        </svg>
      </span>
      <h1 class="notFoundTitle">页面走丢了</h1>
      <p class="notFoundDesc">您访问的页面不存在或已被移除，请检查地址是否正确。</p>
      <div class="notFoundActions">
        <el-button type="primary" @click="goHome">返回首页</el-button>
        <el-button plain @click="goBack">返回上一页</el-button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useRouter } from "vue-router";
import { ElButton } from "element-plus/es/components/button/index";

const router = useRouter();

function goHome() {
  router.push("/");
}

function goBack() {
  if (window.history.length > 1) {
    router.back();
  } else {
    router.push("/");
  }
}
</script>

<style lang="scss" scoped>
.notFound {
  background: var(--qdd-bg);
  color: var(--qdd-text);
  font-family: var(--qdd-font);
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
  width: 100%;
  overflow: hidden;

  .notFoundBg {
    position: absolute;
    inset: 0;
    z-index: 0;
  }

  .notFoundContent {
    position: relative;
    z-index: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;

    .notFoundCode {
      color: var(--qdd-primary);

      .face {
        display: block;
        width: 12em;
        height: auto;

        .faceEyes,
        .faceEyeLid,
        .faceMouthLeft,
        .faceMouthRight,
        .faceNose,
        .facePupil {
          animation: eyes 1s 0.3s cubic-bezier(0.65, 0, 0.35, 1) forwards;
        }

        .faceEyeLid,
        .facePupil {
          animation-duration: 4s;
          animation-delay: 1.3s;
          animation-iteration-count: infinite;
        }

        .faceEyeLid {
          animation-name: eye-lid;
        }

        .faceMouthLeft,
        .faceMouthRight {
          animation-timing-function: cubic-bezier(0.33, 1, 0.68, 1);
        }

        .faceMouthLeft {
          animation-name: mouth-left;
        }

        .faceMouthRight {
          animation-name: mouth-right;
        }

        .faceNose {
          animation-name: nose;
        }

        .facePupil {
          animation-name: pupil;
        }
      }
    }

    .notFoundTitle {
      font-size: 26px;
      font-weight: 700;
      margin: 24px 0 0;
      color: var(--qdd-text);
    }

    .notFoundDesc {
      font-size: 14px;
      line-height: 1.6;
      margin: 12px 0 0;
      color: var(--qdd-muted);
    }

    .notFoundActions {
      display: flex;
      gap: 16px;
      margin-top: 36px;

      .el-button + .el-button {
        margin-left: 0;
      }
    }
  }
}

@keyframes eye-lid {
  from,
  40%,
  45%,
  to {
    transform: translateY(0);
  }
  42.5% {
    transform: translateY(17.5px);
  }
}
@keyframes eyes {
  from {
    transform: translateY(112.5px);
  }
  to {
    transform: translateY(15px);
  }
}
@keyframes pupil {
  from,
  37.5%,
  40%,
  45%,
  87.5%,
  to {
    stroke-dashoffset: 0;
    transform: translate(0, 0);
  }
  12.5%,
  25%,
  62.5%,
  75% {
    stroke-dashoffset: 0;
    transform: translate(-35px, 0);
  }
  42.5% {
    stroke-dashoffset: 35;
    transform: translate(0, 17.5px);
  }
}
@keyframes mouth-left {
  from,
  50% {
    stroke-dashoffset: -102;
  }
  to {
    stroke-dashoffset: 0;
  }
}
@keyframes mouth-right {
  from,
  50% {
    stroke-dashoffset: 102;
  }
  to {
    stroke-dashoffset: 0;
  }
}
@keyframes nose {
  from {
    transform: translate(0, 0);
  }
  to {
    transform: translate(0, 22.5px);
  }
}
</style>
