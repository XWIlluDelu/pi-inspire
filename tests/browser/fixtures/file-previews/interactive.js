import { value } from "./interactive-value.mjs";
const data = await fetch("./interactive.json").then(response => response.json());
document.body.dataset.localModule = value;
document.body.dataset.localFetch = data.value;
