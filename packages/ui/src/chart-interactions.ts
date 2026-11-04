/** Keep plot scrolling for the page; ranges change only through the axis slider. */
export function sliderOnlyZoom(option: Record<string, any>): Record<string, any> {
  if (!option.dataZoom) return option;
  const update = (zoom: Record<string, any>) => zoom.type === "inside" ? {
    ...zoom, disabled: true, zoomOnMouseWheel: false, moveOnMouseWheel: false,
    moveOnMouseMove: false, preventDefaultMouseMove: false,
  } : zoom;
  return { ...option, dataZoom: Array.isArray(option.dataZoom) ? option.dataZoom.map(update) : update(option.dataZoom) };
}
