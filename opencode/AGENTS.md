# Global agent guidance

The plugins in this repo (`background-tasks`, `monitor`, `goal`, `remote-control`) inject their own usage guidance into the system prompt on every turn via `experimental.chat.system.transform`, so their decision rules do not need to be repeated here.
