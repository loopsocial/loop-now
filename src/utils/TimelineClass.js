import {
  FX_TYPES,
  PARAMS_TYPES,
  CLIP_TYPES,
  FX_DESC,
  TRANSFORM2D_KEYS
} from "./Global";
import store from "../store";
import { installAsset } from "./AssetsUtils";
import { HexToRGBA, RGBAToNvsColor } from "./common";

// 该类不修改vuex内的数据, 只对vuex内的数据进行渲染, 且与vuex内的数据使用相同的地址
export default class TimelineClass {
  constructor(canvasId, options) {
    this.streamingContext = nvsGetStreamingContextInstance();
    this.timeline = null;
    this.canvasId = canvasId;
    const { width, height } = options || {};
    this.width = width || 1080;
    this.height = height || 1920;
    this.videoTrack = { raw: null, clips: [] };
    this.audioTrack = { raw: null, clips: [] };
    this.captions = [];
    this.stickers = [];
    this.otherTrackRaw = null;
    this.init();
  }
  // 初始化
  async init() {
    await this.createTimeline();
    this.connectLiveWindow();
  }
  // 创建时间线实例
  async createTimeline() {
    await this.stopEngin();
    if (!this.streamingContext) {
      console.error("stream context is null");
      return;
    }
    const resolution = new NvsVideoResolution(this.width, this.height);
    this.timeline = this.streamingContext.createTimeline(
      resolution,
      new NvsRational(25, 1),
      new NvsAudioResolution(44100, 2)
    );
    if (this.timeline) {
      console.log("初始化时间线完成");
    } else {
      console.warn("时间线创建失败");
    }
  }
  connectLiveWindow(canvasId) {
    if (this.liveWindow) {
      this.streamingContext.removeLiveWindow(this.liveWindow);
    }
    this.liveWindow = this.streamingContext.createLiveWindow(
      canvasId || this.canvasId
    );
    this.liveWindow.setFillMode(NvsLiveWindowFillModeEnum.PreserveAspectFit);
    this.streamingContext.connectTimelineWithLiveWindow(
      this.timeline,
      this.liveWindow
    );
    console.log("连接liveWindow完成");
  }
  initData() {
    const { videos, audios, captions, stickers } = store.state.clip;
    this.videoTrack = { clips: videos, raw: null };
    this.audioTrack = { clips: audios, raw: null };
    this.captions = captions;
    this.stickers = stickers;
  }
  // 构建时间线
  async buildTimeline(clips) {
    if (clips) {
      this.videoTrack = { clips, raw: null };
    } else {
      this.initData();
    }
    console.log("重新构建", this);
    await this.streamingContext.streamingEngineReadyForTimelineModification();
    this.clearVideoTrack();
    this.clearAudioTrack();
    this.clearCaptions();
    this.clearStickers();
    this.buildVideoTrack();
    this.buildAudioTrack();
    await this.buildModule();
    this.captions.map(c => this.addCaption(c));
    this.stickers.map(s => this.addSticker(s));
  }
  async play(startTime, endTime) {
    startTime = startTime === undefined ? this.getCurrentPosition() : startTime;
    this.streamingContext.playbackTimeline(
      this.timeline,
      startTime,
      endTime || -1,
      NvsVideoPreviewSizeModeEnum.LiveWindowSize,
      true,
      0
    );
  }
  isPlaying() {
    const streamingEngineState = this.streamingContext.getStreamingEngineState();
    return (
      streamingEngineState ===
      NvsStreamingEngineStateEnum.StreamingEngineStatePlayback
    );
  }
  stop() {
    this.streamingContext.stop();
  }
  removeLiveWindow(liveWindow) {
    this.streamingContext.removeLiveWindow(liveWindow);
  }
  removeTimeline() {
    this.streamingContext.removeTimeline(this.timeline);
  }
  stopEngin() {
    return this.streamingContext.streamingEngineReadyForTimelineModification();
  }
  seekTimeline(t) {
    t =
      t === undefined
        ? this.getCurrentPosition()
        : Math.min(t, this.timeline.getDuration());
    this.streamingContext.seekTimeline(
      this.timeline,
      t,
      NvsVideoPreviewSizeModeEnum.LiveWindowSize,
      NvsSeekFlagEnum.ShowCaptionPoster |
        NvsSeekFlagEnum.ShowAnimatedStickerPoster
    );
  }
  getCurrentPosition() {
    return this.streamingContext.getTimelineCurrentPosition(this.timeline);
  }
  async buildModule() {
    const { module, videos } = store.state.clip;
    if (!module) return;
    let intro;
    let end;
    const defaultScenes = module.scenes.filter(scene => {
      if (scene.temporal === "end") end = scene;
      else if (scene.temporal === "intro") intro = scene;
      else return true;
    });
    console.log(
      "解析出的模板.片头:",
      intro,
      "中间通用:",
      defaultScenes,
      "片尾：",
      end
    );
    let j = 0;
    for (let index = 0; index < videos.length; index++) {
      const video = videos[index];
      for (let i = 0; i < video.splitList.length; i++) {
        const arr = video.splitList;
        const item = video.splitList[i];
        const v = {
          inPoint: video.inPoint,
          duration: item.captureOut - item.captureIn,
          raw: item.raw,
          videoType: video.videoType
        };
        if (j === 0) {
          await this.applyModuleScene(v, intro || defaultScenes[0]);
        } else if (index === videos.length - 1 && arr.length - 1 === i) {
          const index = Math.min(j - Number(!!intro), defaultScenes.length - 1);
          await this.applyModuleScene(v, end || defaultScenes[index]);
        } else {
          const index = Math.min(j - Number(!!intro), defaultScenes.length - 1);
          await this.applyModuleScene(v, defaultScenes[index]);
        }
        j += 1;
      }
    }
  }
  // 再视频上应用模板scene
  async applyModuleScene(video, scene) {
    if (!scene) return;
    const { raw, inPoint, duration, videoType } = video;
    const rawLayer = scene.layers.find(l => l.type === "raw");
    const moduleLayer = scene.layers.find(l => l.type === "module");
    const module = rawLayer[videoType];
    if (module) {
      const { scaleX, scaleY, translationX, translationY } = module;
      const transform2DFx = raw.appendBuiltinFx(FX_DESC.TRANSFORM2D);
      transform2DFx.setFloatVal(TRANSFORM2D_KEYS.SCALE_X, scaleX);
      transform2DFx.setFloatVal(TRANSFORM2D_KEYS.SCALE_Y, scaleY);
      transform2DFx.setFloatVal(TRANSFORM2D_KEYS.TRANS_X, translationX);
      transform2DFx.setFloatVal(TRANSFORM2D_KEYS.TRANS_Y, translationY);
    }
    // 添加模板字幕
    if (moduleLayer) {
      const { text, image } = moduleLayer;
      text.map(item => {
        // TODO: 还未考虑字体，以及frameHeight、frameWidth
        this.addCaption({
          styleDesc: item.styleDesc,
          font: item.font,
          text: item.value,
          inPoint: inPoint,
          duration: duration || video.duration,
          z: item.zValue,
          color: item.fontColor,
          fontSize: item.fontSize,
          align: item.textXAlignment,
          translationY: item.translationY,
          translationX: item.translationX,
          frameWidth: item.frameWidth,
          frameHeight: item.frameHeight
        });
      });
      // 添加图片
      if (image && image.source) {
        const { m3u8Url } = image.source;
        if (!m3u8Url) {
          console.warn("图片添加失败，缺少m3u8Url", image);
          return;
        }
        const m3u8Path = await installAsset(m3u8Url);
        const clip = this.otherTrackRaw.addClip2(
          m3u8Path,
          inPoint,
          0,
          duration
        );
        if (!clip) {
          console.warn("图片添加失败", m3u8Path, image);
          return;
        }
        clip.setImageMotionAnimationEnabled(false);
        clip.setImageMotionMode(0);
      }
    }
  }
  buildVideoTrack() {
    if (!this.videoTrack.raw) {
      this.videoTrack.raw = this.timeline.appendVideoTrack();
    }
    if (!this.otherTrackRaw) {
      this.otherTrackRaw = this.timeline.appendVideoTrack();
    }
    if (Array.isArray(this.videoTrack.clips)) {
      this.videoTrack.clips.map(clip => {
        clip.splitList.reduce((res, item) => {
          const clipInfo = {
            m3u8Path: clip.m3u8Path,
            inPoint: res,
            trimIn: item.captureIn,
            trimOut: item.captureOut
          };
          item.raw = this.addVideoClip(clipInfo, this.videoTrack.raw);
          this.addVideoFx(item);
          if (clip.videoType === CLIP_TYPES.IMAGE) {
            item.raw.setImageMotionAnimationEnabled(clip.motion);
            item.raw.setImageMotionMode(0);
          }
          return res + item.captureOut - item.captureIn;
        }, clip.inPoint);
      });
    }
  }
  // 重新添加一次clip, 用于修改trim
  // 删除clip的时候会丢失区间内的字幕, 改用rebuildTimeline
  afreshVideoClip(clip) {
    // 删除这个clip下所有的切片
    clip = this.videoTrack.clips.find(c => c.uuid === clip.uuid);
    const index = clip.splitList[0].raw.getIndex();
    clip.splitList.map(({ raw }) => {
      if (raw) {
        const index = raw.getIndex();
        this.videoTrack.raw.removeClip(index, false);
      }
    });
    // 修改后的clip切片重新插入一次
    clip.splitList.reduce((res, item, i) => {
      item.raw = this.videoTrack.raw.insertClip2(
        clip.m3u8Path,
        item.captureIn,
        item.captureOut,
        index + i
      );
      this.addVideoFx(item);
      if (clip.videoType === CLIP_TYPES.IMAGE && !clip.motion) {
        item.raw.setImageMotionAnimationEnabled(false);
      }
      return res + item.captureOut - item.captureIn;
    }, clip.inPoint);
  }
  // clip添加特效, 用户修剪视频
  addVideoFx(clip) {
    clip.videoFxs.map(fx => {
      if (fx.type === FX_TYPES.BUILTIN) {
        fx.raw = clip.raw.appendBuiltinFx(fx.desc);
      } else if (fx.type === FX_TYPES.PACKAGE) {
        fx.raw = clip.raw.appendPackagedFx(fx.desc);
      }
      if (fx.desc === FX_DESC.MOSAIC) {
        // 添加一个视野内的遮罩
        fx.raw.setFloatVal("Unit Size", 0);
        fx.raw.setFilterIntensity(1);
        fx.raw.setRegional(true);
        fx.raw.setIgnoreBackground(true);
        fx.raw.setInverseRegion(false);
        fx.raw.setRegionalFeatherWidth(0);
        const region = new NvsVectorFloat();
        // pos1
        region.push_back(-1);
        region.push_back(1);
        // pos2
        region.push_back(-1);
        region.push_back(-1);
        // pos3
        region.push_back(1);
        region.push_back(-1);
        // pos4
        region.push_back(1);
        region.push_back(1);
        fx.raw.setRegion(region);
        // 遮罩效果写死, 不需要再判断特效参数了
        return;
      }
      fx.params.map(({ type, key, value }) => {
        switch (type) {
          case PARAMS_TYPES.STRING:
            fx.raw.setStringVal(key, value);
            break;
          case PARAMS_TYPES.FLOAT:
            fx.raw.setFloatVal(key, value);
            break;
          case PARAMS_TYPES.BOOL:
            fx.raw.setBooleanVal(key, value);
            break;
          case PARAMS_TYPES.INT:
            fx.raw.setIntVal(key, value);
            break;
          case PARAMS_TYPES.COLOR:
            fx.raw.setColorVal(key, value);
            break;
          default:
            break;
        }
      });
    });
  }
  buildAudioTrack() {
    if (!this.audioTrack.raw) {
      this.audioTrack.raw = this.timeline.appendAudioTrack();
    }
    if (Array.isArray(this.audioTrack.clips)) {
      this.audioTrack.clips.map(clip => {
        clip.raw = this.addAudioClip(clip, this.audioTrack.raw);
      });
    }
  }
  addCaption(caption) {
    const {
      text,
      inPoint,
      duration,
      styleDesc,
      fontSize,
      scale,
      align,
      rotation,
      translationX,
      color,
      translationY,
      frameWidth,
      frameHeight,
      font,
      z
    } = caption;
    const captionRaw = this.timeline.addCaption(
      text,
      inPoint,
      duration,
      styleDesc || "",
      false
    );
    if (!captionRaw) {
      console.warn("caption add fail", caption);
      return;
    }
    caption.raw = captionRaw;
    if (scale !== undefined) {
      captionRaw.setScaleX(scale);
      captionRaw.setScaleY(scale);
    }
    rotation !== undefined && captionRaw.setRotationZ(rotation);
    if (translationX !== undefined && translationY !== undefined) {
      captionRaw.setCaptionTranslation(
        new NvsPointF(translationX, translationY)
      );
    }
    if (color) {
      const rgba = color[0] === "#" ? HexToRGBA(color) : color;
      const nvsColor = RGBAToNvsColor(rgba);
      captionRaw.setTextColor(nvsColor);
    }
    if (align) {
      const temp = {
        left: 0,
        center: 1,
        right: 2
      };
      captionRaw.setTextAlignment(temp[align]);
    }
    if (frameWidth && frameHeight) {
      const { videoWidth, videoHeight } = store.state.clip;
      const x = this.getValue(frameWidth, videoWidth);
      const y = this.getValue(frameHeight, videoHeight);
      const rect = {
        left: -0.5 * x,
        top: 0.5 * y,
        right: 0.5 * x,
        bottom: -0.5 * y
      };
      captionRaw.setTextFrameOriginRect(rect);
      fontSize > 0 && captionRaw.setFrameCaptionMaxFontSize(fontSize);
    } else {
      fontSize !== undefined && captionRaw.setFontSize(fontSize);
    }
    if (font) {
      captionRaw.setFontFamily(font);
    }
    if (z) captionRaw.setZValue(z);
    return captionRaw;
  }
  getValue(string, length) {
    if (string.search("%") > -1) {
      return (parseFloat(string) * length) / 100;
    }
    return parseFloat(string);
  }
  static setCaption(caption) {
    const {
      raw,
      fontSize,
      scale,
      rotation,
      translationX,
      translationY
    } = caption;
    if (!raw) {
      console.warn("caption add fail", caption);
      return;
    }
    if (scale !== undefined) {
      raw.setScaleX(scale);
      raw.setScaleY(scale);
    }
    rotation !== undefined && raw.setRotationZ(rotation);
    if (translationX !== undefined && translationY !== undefined) {
      raw.setCaptionTranslation(new NvsPointF(translationX, translationY));
    }
    fontSize !== undefined && raw.setFontSize(fontSize);
  }
  addSticker(sticker) {
    const {
      inPoint,
      duration,
      desc,
      scale,
      rotation,
      translationX,
      translationY,
      horizontalFlip,
      verticalFlip,
      z
    } = sticker;
    const stickerRaw = this.timeline.addAnimatedSticker(
      inPoint,
      duration,
      desc + "",
      false,
      false,
      ""
    );
    if (!stickerRaw) {
      console.warn("sticker add fail", sticker);
      return false;
    }
    sticker.raw = stickerRaw;
    scale !== undefined && stickerRaw.setScale(scale);
    rotation !== undefined && stickerRaw.setRotationZ(rotation);
    if (translationX !== undefined && translationX !== undefined) {
      const targetPoint = new NvsPointF(translationX, translationY);
      stickerRaw.setTranslation(targetPoint);
    }
    horizontalFlip !== undefined &&
      stickerRaw.setHorizontalFlip(horizontalFlip);
    verticalFlip !== undefined && stickerRaw.setVerticalFlip(verticalFlip);
    z !== undefined && stickerRaw.setZValue(z);
    return true;
  }
  addVideoClip(clip, trackRaw) {
    const { m3u8Path, inPoint, trimIn, trimOut } = clip;
    trackRaw = trackRaw || this.videoTrack.raw;
    return trackRaw.addClip2(m3u8Path, inPoint, trimIn, trimOut);
  }
  deleteClipByIndex(type, index) {
    this[`${type}Track`].raw.removeClip(index, false);
  }
  addAudioClip(clip, trackRaw) {
    const { m3u8Path, inPoint, trimIn, trimOut, orgDuration } = clip;
    trackRaw = trackRaw || this.audioTrack.raw;
    return trackRaw.addClip2(
      m3u8Path,
      inPoint,
      trimIn || 0,
      trimOut || orgDuration
    );
  }
  clearCaptions() {
    let caption = this.timeline.getFirstCaption();
    while (caption) {
      caption = this.timeline.removeCaption(caption);
    }
  }
  clearStickers() {
    let sticker = this.timeline.getFirstAnimatedSticker();
    while (sticker) {
      sticker = this.timeline.removeAnimatedSticker(sticker);
    }
  }
  clearVideoTrack() {
    while (this.timeline.videoTrackCount() !== 0) {
      this.timeline.removeVideoTrack(0);
    }
    this.videoTrack.raw = null;
    this.otherTrackRaw = null;
  }
  clearAudioTrack() {
    while (this.timeline.audioTrackCount() !== 0) {
      this.timeline.removeAudioTrack(0);
      this.audioTrack.raw = null;
    }
  }
  destroy() {
    if (this.isPlaying) this.stop();
    this.liveWindow && this.removeLiveWindow(this.liveWindow);
    this.removeTimeline();
  }
  getImgFromTimeline(point) {
    return new Promise((resolve, reject) => {
      window.streamingContext.addEventListener(
        "onImageGrabbedArrived",
        function slot(data) {
          window.streamingContext.removeEventListener(
            "onImageGrabbedArrived",
            slot
          );
          resolve(data);
        }
      );
      setTimeout(() => {
        reject(new Error("Get cover timeout"));
      }, 5000);
      this.streamingContext.grabImageFromTimeline(
        this.timeline,
        point || 0,
        new NvsRational(1, 1),
        0
      );
    });
  }
}
