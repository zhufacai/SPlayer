import { Howl, Howler } from "howler";
import { musicData, siteStatus, siteSettings, siteData } from "@/stores";
import { getSongUrl, getSongLyric, songScrobble } from "@/api/song";
import { checkPlatform, getLocalCoverData } from "@/utils/helper";
import { decode as base642Buffer } from "@/utils/base64";
import { getSongPlayTime } from "@/utils/timeTools";
import { getCoverGradient } from "@/utils/cover-color";
import { isLogin } from "@/utils/auth";
import parseLyric from "@/utils/parseLyric";

// 全局播放器
let player;
// 时长定时器
let seekInterval;
let justSeekInterval;
let scrobbleTimeout;
// 重试次数
let testNumber = 0;
// 是否结束
let isPlayEnd = true;

/**
 * 初始化播放器
 */
export const initPlayer = async (playNow = false) => {
  try {
    // 停止播放当前歌曲
    soundStop();
    // 获取基础数据
    const music = musicData();
    const status = siteStatus();
    const settings = siteSettings();
    const { playList, playIndex } = music;
    // 当前播放歌曲数据
    const playSongData = music.getPlaySongData;
    // 是否为本地歌曲
    const isLocalSong = playSongData?.path ? true : false;
    // 获取封面
    if (isLocalSong) {
      music.playSongData.localCover = await getLocalCoverData(playSongData?.path);
    }
    const cover = isLocalSong ? music.playSongData?.localCover : playSongData?.coverSize;
    // 歌词归位
    music.playSongLyricIndex = -1;
    // 在线歌曲
    if (!isLocalSong) {
      // 获取歌曲信息
      const { id } = playSongData;
      if (!id) return false;
      // 开启加载状态
      status.playLoading = true;
      // 获取播放地址
      const url = await getNormalSongUrl(id, status, playNow);
      // 正常播放地址
      if (url) {
        status.playUseOtherSource = false;
        createPlayer(url);
      }
      // 无法正常获取播放地址
      else if (checkPlatform.electron() && settings.useUnmServer) {
        const url = await getFromUnblockMusic(playSongData, status, playNow);
        if (url) {
          status.playUseOtherSource = true;
          createPlayer(url);
        } else {
          status.playUseOtherSource = false;
          changePlayIndex("next", true);
        }
      }
      // 下一曲
      else {
        if (playIndex !== playList.length - 1) {
          changePlayIndex();
        } else {
          status.playLoading = false;
          status.playState = false;
          $message.warning("列表中暂无可播放歌曲", { closable: true, duration: 5000 });
        }
      }
    }
    // 本地歌曲
    else if (isLocalSong && playList?.length) {
      const url = playList[playIndex]?.path;
      if (playNow && url) status.playState = true;
      if (url) {
        // 创建播放器
        createPlayer(url);
      } else {
        changePlayIndex("next", playNow);
      }
    }
    // 获取歌词
    getSongLyricData(isLocalSong, playSongData);
    // 初始化媒体会话控制
    initMediaSession(playSongData, isLocalSong, cover);
    // 获取图片主色
    getColorMainColor(isLocalSong, cover);
  } catch (error) {
    testNumber++;
    // 错误次数过多
    if (testNumber > 10) {
      $dialog.error({
        title: "致命性错误",
        content: "歌曲播放中出现错误次数过多，请刷新后重试",
        positiveText: "刷新",
        onPositiveClick: () => {
          location.reload();
        },
      });
      return false;
    }
    // 下一曲
    // changePlayIndex();
    console.error("初始化音乐播放器出错：", error);
    $message.error("初始化音乐播放器出错");
  }
};

/**
 * 获取普通模式下的音乐播放地址
 * @param {number} id - 歌曲 id
 * @returns {Promise<?string>} - 歌曲播放地址，如果获取失败或歌曲无法播放则返回 null
 */
const getNormalSongUrl = async (id, status, playNow) => {
  try {
    const settings = siteSettings();
    const res = await getSongUrl(id, settings.songLevel);
    // 检查是否有有效的响应数据
    if (!res.data?.[0] || !res.data?.[0]?.url) return null;
    // 检查是否只能试听
    if (res.data?.[0]?.freeTrialInfo !== null && checkPlatform.electron()) return null;
    // 返回歌曲地址，将 http 转换为 https
    const url = res.data[0].url.replace(/^http:/, "https:");
    // 更改状态
    if (playNow && url) status.playState = true;
    status.playLoading = false;
    return url;
  } catch (error) {
    status.playLoading = false;
    console.error("获取歌曲地址遇到错误：" + error);
    throw error;
  }
};

/**
 * 网易云解灰
 * @param {string} id - 歌曲 id
 * @returns {Promise<AudioPlayer|null>} - 创建播放器
 */
const getFromUnblockMusic = async (data, status, playNow) => {
  try {
    console.info("🎵 开始解灰：", data);
    // 调用解灰
    let musicUrl = await electron.ipcRenderer.invoke("getMusicNumUrl", JSON.stringify(data));
    if (!musicUrl) {
      $message.error("该歌曲暂无音源");
      status.playLoading = false;
      return null;
    }
    // 处理 bili 音源
    if (musicUrl.includes("bilivideo.com")) {
      const result = await electron.ipcRenderer.invoke("getBiliUrlData", musicUrl);
      // 将获取的数据转换为 ArrayBuffer
      const buffer = base642Buffer(result);
      // 创建一个新的 Blob，并生成相应的对象 URL
      const source = URL.createObjectURL(new Blob([buffer]));
      // 如果之前的 musicUrl 存在，则销毁旧的对象 URL
      if (musicUrl) {
        URL.revokeObjectURL(musicUrl);
      }
      // 更新 musicUrl 为新的对象 URL
      musicUrl = source;
    }
    if (playNow) status.playState = true;
    status.playLoading = false;
    return musicUrl;
  } catch (error) {
    status.playLoading = false;
    console.error("歌曲解灰遇到错误：" + error.message);
    $message.error("歌曲解灰遇到错误");
    throw error;
  }
};

/**
 * 创建播放器
 * @param {string} src - 音频文件地址
 * @param {number} volume - 音量（ 默认为 0.7 ）
 * @param {number} seek - 初始播放进度（ 默认为 0 ）
 */
export const createPlayer = async (src, autoPlay = true) => {
  console.log("播放地址：", src);
  try {
    // pinia
    const music = musicData();
    const status = siteStatus();
    const settings = siteSettings();
    const { playSongSource } = music;
    // 当前播放歌曲数据
    const playSongData = music.getPlaySongData;
    // 初始化播放器
    player = new Howl({
      src: [src],
      format: ["mp3", "flac"],
      html5: true,
      pool: 10,
      preload: true,
      volume: music.playVolume,
      rate: music.playRate,
    });
    // 写入播放历史
    music.setPlayHistory(playSongData);
    // 加载完成
    player?.once("load", () => {
      console.info("🎵 加载完成", player, status.playState);
      // 自动播放
      if (autoPlay && status.playState) {
        setSeek();
        fadePlayOrPause("play");
      }
      // 恢复进度（防止播放到结尾时触发 bug）
      if (
        settings.memorySeek &&
        music.playTimeData?.duration - music.playTimeData?.currentTime > 2
      ) {
        setSeek(music.playTimeData?.currentTime ?? 0);
      } else {
        setSeek();
        music.playTimeData.bar = "0";
      }
      // 取消加载状态
      status.playLoading = false;
      // 发送歌曲名
      if (checkPlatform.electron()) {
        const toolTip =
          playSongData.name +
          " - " +
          (Array.isArray(playSongData.artists)
            ? playSongData.artists.map((ar) => ar.name).join(" / ")
            : playSongData.artists || "未知歌手");
        electron.ipcRenderer.send("sendSongName", toolTip);
      }
      // 听歌打卡
      if (isLogin() && !playSongData?.path) {
        clearTimeout(scrobbleTimeout);
        scrobbleTimeout = setTimeout(async () => {
          const result = await songScrobble(playSongData.id, playSongSource, 5);
          if (result.code === 200) console.log("歌曲打卡完成：", result);
        }, 5000);
      }
    });
    // 开始播放
    player?.on("play", () => {
      console.info("🎵 开始播放：", playSongData);
      isPlayEnd = false;
      setAllInterval();
      // 更改状态
      status.playState = true;
    });
    // 暂停播放
    player?.on("pause", () => {
      console.info("⏸ 暂停播放");
      cleanAllInterval();
      // 更改状态
      status.playState = false;
    });
    // 结束播放
    player?.on("end", () => {
      console.info("🎵 播放结束");
      isPlayEnd = true;
      // 停止定时器
      cleanAllInterval();
      // 下一曲
      changePlayIndex();
    });
    // 加载失败
    player?.on("loaderror", (_, errCode) => {
      console.log("错误");
      // 更改状态
      status.playLoading = false;
      status.playState = false;
      // https://github.com/goldfire/howler.js?tab=readme-ov-file#onloaderror-function
      // 1-用户代理应用户请求中止了获取媒体资源的过程
      // 2-某个描述的网络错误导致用户代理在确定资源可用后停止获取媒体资源
      // 3-在确定资源可用后，对媒体资源进行解码时发生某种描述错误
      // 4-由src属性或分配的媒体提供程序对象指示的媒体资源不合适
      if (errCode === 3) {
        $message.error("播放出错，媒体进行解码时发生错误");
      } else if (errCode === 4) {
        $message.error("播放出错，不支持的音频格式");
      } else {
        $message.error("播放遇到错误");
      }
      // 下一曲
      changePlayIndex();
    });
  } catch (error) {
    console.error("播放遇到错误：" + error);
    $message.error("播放遇到错误，请重试");
    throw error;
  }
};

/**
 * 播放下一首或上一首歌曲
 * @param {string} type - 更改索引的类型  "next" / "prev"
 */
export const changePlayIndex = async (type = "next", play = false) => {
  // pinia
  const music = musicData();
  const state = siteStatus();
  // 解构音乐数据
  const { playMode, playSongMode, playHeartbeatMode, playList } = music;
  // 清除定时器
  cleanAllInterval();
  // 歌词归位
  music.playSongLyricIndex = -1;
  // 私人FM模式
  if (playMode === "fm") {
    await music.setPersonalFm(true);
    // 渐出音乐
    if (!isPlayEnd) await fadePlayOrPause("pause");
    // 初始化播放器
    initPlayer(play);
    return true;
  }
  // 根据播放模式确定要操作的播放列表和其长度
  const listLength = playList?.length || 0;
  // 根据播放歌曲模式执行不同的操作
  if (state.hasNextSong) {
    music.playIndex += type === "next" ? 1 : -1;
    state.hasNextSong = false;
  } else {
    if (playSongMode === "normal" || playHeartbeatMode) {
      // 正常模式
      music.playIndex += type === "next" ? 1 : -1;
    } else if (playSongMode === "random") {
      // 随机模式
      music.playIndex = Math.floor(Math.random() * listLength);
    } else if (playSongMode === "repeat") {
      // 单曲循环模式
      setSeek();
      fadePlayOrPause("play");
    }
  }
  // 检查播放索引是否越界
  if (playSongMode !== "repeat") {
    if (music.playIndex < 0) {
      music.playIndex = listLength - 1;
    } else if (music.playIndex >= listLength) {
      music.playIndex = 0;
    }
    // 赋值当前播放歌曲信息
    const songData = playList?.[music.playIndex];
    if (songData) {
      music.playSongData = songData;
      console.log(songData);
      // 渐出音乐
      if (!isPlayEnd) await fadePlayOrPause("pause");
      // 初始化播放器
      initPlayer(play);
    } else {
      $message.error("歌曲信息读取错误，跳至下一曲");
      changePlayIndex("next", play);
    }
  }
};

/**
 * 在当前播放歌曲后添加
 * @param {Object} data - 歌曲信息
 */
export const addSongToNext = (data, play = false) => {
  try {
    const music = musicData();
    const state = siteStatus();
    // 更改播放模式
    state.hasNextSong = true;
    // 查找是否存在于播放列表
    const index = music.playList.findIndex((v) => v.id === data.id);
    // 若存在
    if (index !== -1) {
      console.log("已存在", index);
      // 移动至当前歌曲的下一曲
      const currentSongIndex = music.playIndex;
      const nextSongIndex = currentSongIndex + 1;
      // 如果移动的位置不是当前位置，且不是最后一首歌曲
      if (index !== currentSongIndex && nextSongIndex < music.playList.length) {
        // 移动歌曲
        music.playList.splice(nextSongIndex, 0, music.playList.splice(index, 1)[0]);
      }
      // 更新播放索引
      if (play) music.playIndex = nextSongIndex;
    }
    // 添加至播放列表
    else {
      // music.playList.push(data);
      music.playList.splice(music.playIndex + 1, 0, data);
      if (play) music.playIndex++;
    }
    // 是否立即播放
    play ? fadePlayOrPause("play") : $message.success("已添加至下一首播放");
  } catch (error) {
    console.error("添加播放歌曲失败：", error);
  }
};

/**
 * 音频渐入渐出
 * @param {String} [type="play"] - 渐入渐出
 */
export const fadePlayOrPause = (type = "play") => {
  const settings = siteSettings();
  const duration = settings.songVolumeFade ? 300 : 0;
  return new Promise((resolve) => {
    const music = musicData();
    // 渐入
    if (type === "play") {
      if (player?.playing()) {
        resolve();
        return;
      }
      player?.play();
      // 更新播放进度
      setAllInterval();
      player?.once("play", () => {
        player?.fade(0, music.playVolume, duration);
        player?.once("fade", () => {
          resolve();
        });
      });
    }
    // 渐出
    else if (type === "pause") {
      player?.fade(music.playVolume, 0, duration);
      player?.once("fade", () => {
        player?.pause();
        cleanAllInterval();
        resolve();
      });
    }
  });
};

/**
 * 播放或暂停
 */
export const playOrPause = async () => {
  const status = player?.playing();
  await fadePlayOrPause(status ? "pause" : "play");
};

/**
 * 设置倍速
 * @param {number} rate - 设置的倍速值
 */
export const setRate = (rate) => {
  player?.rate(Number(rate));
};

/**
 * 设置音量
 * @param {number} volume - 设置的音量值，0-1之间的浮点数
 */
export const setVolume = (volume) => {
  player?.volume(Number(volume));
};

/**
 * 检查是否存在于播放器且正在播放
 */
export const checkPlayer = () => {
  return player && player?.playing();
};

/**
 * 停止播放器
 */
export const soundStop = () => {
  player?.stop();
  // setSeek();
  Howler.unload();
};

/**
 * 调整静音
 */
export const setVolumeMute = () => {
  const music = musicData();
  if (music.playVolume > 0) {
    music.playVolumeMute = music.playVolume;
    music.playVolume = 0;
  } else {
    music.playVolume = music.playVolumeMute;
  }
  player?.volume(music.playVolume);
};

/**
 * 设置进度
 * @param {number} seek - 设置的进度值，0-1之间的浮点数
 */
export const setSeek = (seek = 0) => {
  player?.seek(seek);
};

/**
 * 获取进度
 * @return {number} seek - 获取的进度值，0-1之间的浮点数
 */
export const getSeek = () => {
  console.log(player.seek());
  if (player) {
    return player.seek();
  }
  return 0;
};

/**
 * 更改播放进度
 */
const setAudioTime = () => {
  if (player?.playing()) {
    const music = musicData();
    const settings = siteSettings();
    const currentTime = player?.seek();
    const duration = player?._duration;
    // 计算数据
    const bar = duration ? ((currentTime / duration) * 100).toFixed(2) : 0;
    const played = getSongPlayTime(currentTime);
    const durationTime = getSongPlayTime(duration);
    // 计算当前歌词播放索引
    const lrcType = !music.playSongLyric.hasYrc || !settings.showYrc;
    const lyrics = lrcType ? music.playSongLyric.lrc : music.playSongLyric.yrc;
    const lyricsIndex = lyrics?.findIndex((v) => v?.time >= currentTime);
    // 赋值数据
    music.playTimeData = { currentTime, duration, bar, played, durationTime };
    music.playSongLyricIndex = lyricsIndex === -1 ? lyrics.length - 1 : lyricsIndex - 1;
    // 显示进度条
    if (checkPlatform.electron() && settings.showTaskbarProgress) {
      electron.ipcRenderer.send("setProgressBar", bar);
    }
  }
};

/**
 * 更改播放进度（频繁）
 */
const justSetSeek = () => {
  if (player?.playing()) {
    const status = siteStatus();
    const currentTime = player?.seek() || 0;
    status.playSeek = currentTime;
  }
};

/**
 * 获取歌曲的歌词数据并解析
 * @param {object} data - 歌曲的数据
 */
const getSongLyricData = async (islocal, data) => {
  if (!data?.id) return false;
  try {
    const music = musicData();
    const setDefaults = () => {
      music.playSongLyric = {
        lrc: [],
        yrc: [],
        hasTran: false,
        hasRoma: false,
        hasYrc: false,
      };
    };
    if (islocal) {
      const lyricData = await electron.ipcRenderer.invoke("getMusicLyric", data?.path);
      if (lyricData) {
        music.playSongLyric = parseLyric({ lrc: { lyric: lyricData } });
      } else {
        console.log("该歌曲暂无歌词");
        setDefaults();
      }
    } else {
      const lyricResponse = await getSongLyric(data?.id);
      const lyricData = lyricResponse?.lrc;
      if (lyricData) {
        music.playSongLyric = parseLyric(lyricResponse);
      } else {
        console.log("该歌曲暂无歌词");
        setDefaults();
      }
    }
  } catch (err) {
    $message.error("歌词处理出错");
    console.error("歌词处理出错：", err);
  }
};

/**
 * 初始化媒体会话控制
 * 如果浏览器支持媒体会话控制（ Media Session API ），则关联各类操作
 * @param {object} data - 当前播放数据
 * @param {string} islocal - 是否为本地歌曲
 * @param {string} cover - 封面图像的URL或数据
 */
const initMediaSession = async (data, islocal, cover) => {
  if ("mediaSession" in navigator) {
    // 歌曲信息
    navigator.mediaSession.metadata = new MediaMetadata({
      title: data.name,
      artist: islocal ? data.artists : data.artists?.map((a) => a.name)?.join(" & "),
      album: islocal ? data.album : data.album.name,
      artwork: islocal
        ? [
            {
              src: cover,
              sizes: "1024x1024",
            },
          ]
        : [
            {
              src: cover?.s,
              sizes: "100x100",
            },
            {
              src: cover?.m,
              sizes: "300x300",
            },
            {
              src: cover?.l,
              sizes: "1024x1024",
            },
          ],
      length: data?.duration,
    });
    // 按键关联
    navigator.mediaSession.setActionHandler("play", async () => {
      await fadePlayOrPause("play");
    });
    navigator.mediaSession.setActionHandler("pause", async () => {
      await fadePlayOrPause("pause");
    });
    navigator.mediaSession.setActionHandler("previoustrack", () => {
      changePlayIndex("prev", true);
    });
    navigator.mediaSession.setActionHandler("nexttrack", () => {
      changePlayIndex("next", true);
    });
  }
};

/**
 * 从封面图像中提取主要颜色，并根据亮度进行选择
 * @param {string} islocal - 是否为本地歌曲
 * @param {string} cover - 封面图像的URL或数据
 * @returns {string} - 主要颜色的RGB十六进制表示
 */
const getColorMainColor = async (islocal, cover) => {
  const data = siteData();
  try {
    // 获取封面图像的URL
    if (!cover) return (data.coverColor = {});
    const colorUrl = islocal ? cover : cover.s;
    // 获取渐变色背景
    const gradientColor = await getCoverGradient(colorUrl);
    data.coverBackground = gradientColor;
  } catch (error) {
    console.error("封面颜色获取失败：", error);
    data.coverColor = {};
  }
};

/*
 * 清除定时器
 */
const cleanAllInterval = () => {
  clearInterval(seekInterval);
  clearInterval(justSeekInterval);
  seekInterval = null;
  justSeekInterval = null;
};

/**
 * 更新定时器
 */
const setAllInterval = () => {
  cleanAllInterval();
  // 启动定时器
  seekInterval = setInterval(() => setAudioTime(), 250);
  justSeekInterval = setInterval(() => justSetSeek(), 17);
};
