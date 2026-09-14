import TimeAgo from "javascript-time-ago";
import zh from "javascript-time-ago/locale/zh";

TimeAgo.addDefaultLocale(zh);

export const timeAgo = new TimeAgo("zh-CN");
