// Adapted from Derrors/iphone-control PR #34, ff78e757 (MIT).
// Native screenshots are resized to phone point dimensions: JPEG pixels are tap points.
export function toPhonePoint(clientX, clientY, rect, width, height) {
  if (!(width > 0 && height > 0 && rect.width > 0 && rect.height > 0))
    return null;
  const scale = Math.min(rect.width / width, rect.height / height);
  const w = width * scale,
    h = height * scale;
  const x = (clientX - rect.left - (rect.width - w) / 2) / scale;
  const y = (clientY - rect.top - (rect.height - h) / 2) / scale;
  if (x < 0 || y < 0 || x > width || y > height) return null;
  return { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 };
}
export function pointerCommand(start, end) {
  if (!start?.point || !end?.point) return null;
  const seconds = Math.min(10, Math.max(0.1, (end.time - start.time) / 1000));
  if (Math.hypot(end.x - start.x, end.y - start.y) < 8) {
    return seconds < 0.5
      ? { tool: "iphone_tap", args: start.point }
      : { tool: "iphone_long_press", args: { ...start.point, seconds } };
  }
  return {
    tool: "iphone_swipe",
    args: {
      from_x: start.point.x,
      from_y: start.point.y,
      to_x: end.point.x,
      to_y: end.point.y,
      seconds,
    },
  };
}
