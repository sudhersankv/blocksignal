# Dark "neon" Kibana Maps view in 5 steps

1. **Dark mode and data views.** Turn on **Stack Management > Advanced Settings > Theme: dark** (or use your avatar menu > Appearance > Dark) and reload.
   Create data views `sf311-encampments` (time field `requested`) and `sf-pitstops` (no time field).
2. **New map, dark basemap.** Go to **Analytics > Maps > Create map**. Edit the default basemap layer and choose **Dark** for the EMS Basemaps style.
   Center on San Francisco (about 37.77, -122.43, zoom 13). Set the time picker to *Last 7 days*.
3. **Hotspot grid (aggregation layer).** Add a layer of type **Clusters** (or **Heat map**) using `sf311-encampments` > `location`. Show as **Grid** with high resolution.
   Style the fill by *count* with a dark-to-neon ramp (purple, magenta, cyan) at 0.8 opacity. Name it "311 encampment reports".
4. **Pit Stops (documents layer).** Add **Documents** from `sf-pitstops` > `location`. Use a bright cyan/green `marker` icon, size 10, and label it with `name`.
   Add tooltip fields `name`, `hoursRaw`, `address`. For gap circles, add a second Documents layer from `sf-pitstops`.
   Style it as a large semi-transparent symbol (size about 40, fill alpha 0.15, neon border), or draw an 800 m distance filter with **Tools > Draw distance**.
   Clusters outside these circles are the service gaps.
5. **Story layers and save.** Add a filtered Documents layer from `sf311-encampments` with query `outcome : ("declined" or "not_found" or "medical")`.
   Use hot pink points, label it "Services not landing", and save as **BlockSignal: service gaps**. For the pitch, go full screen.
   Turn on the layer filter `district : "6"` live to zoom into one supervisor district.
