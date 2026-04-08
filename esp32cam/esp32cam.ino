#include "esp_camera.h"
#include "FS.h"
#include "SD_MMC.h"
#include <WiFi.h>
#include <HTTPClient.h>
#include <string.h>

const char* ssid = "ALHN-A823";
const char* password = "2137487445";
const char* serverUrl = "http://192.168.1.70:3000/api/reconstruct-analyze";

#define PWDN_GPIO_NUM     32
#define RESET_GPIO_NUM    -1
#define XCLK_GPIO_NUM      0
#define SIOD_GPIO_NUM     26
#define SIOC_GPIO_NUM     27
#define Y9_GPIO_NUM       35
#define Y8_GPIO_NUM       34
#define Y7_GPIO_NUM       39
#define Y6_GPIO_NUM       36
#define Y5_GPIO_NUM       21
#define Y4_GPIO_NUM       19
#define Y3_GPIO_NUM       18
#define Y2_GPIO_NUM        5
#define VSYNC_GPIO_NUM    25
#define HREF_GPIO_NUM     23
#define PCLK_GPIO_NUM     22

static const char hexChars[] = "0123456789abcdef";

void initCamera() {
  camera_config_t config;

  config.ledc_channel = LEDC_CHANNEL_0;
  config.ledc_timer = LEDC_TIMER_0;

  config.pin_d0 = Y2_GPIO_NUM;
  config.pin_d1 = Y3_GPIO_NUM;
  config.pin_d2 = Y4_GPIO_NUM;
  config.pin_d3 = Y5_GPIO_NUM;
  config.pin_d4 = Y6_GPIO_NUM;
  config.pin_d5 = Y7_GPIO_NUM;
  config.pin_d6 = Y8_GPIO_NUM;
  config.pin_d7 = Y9_GPIO_NUM;

  config.pin_xclk = XCLK_GPIO_NUM;
  config.pin_pclk = PCLK_GPIO_NUM;
  config.pin_vsync = VSYNC_GPIO_NUM;
  config.pin_href = HREF_GPIO_NUM;

  config.pin_sscb_sda = SIOD_GPIO_NUM;
  config.pin_sscb_scl = SIOC_GPIO_NUM;

  config.pin_pwdn = PWDN_GPIO_NUM;
  config.pin_reset = RESET_GPIO_NUM;

  config.xclk_freq_hz = 20000000;
  config.pixel_format = PIXFORMAT_JPEG;

  config.frame_size = FRAMESIZE_VGA;
  config.jpeg_quality = 10;
  config.fb_count = 1;

  esp_err_t err = esp_camera_init(&config);
  if (err != ESP_OK) {
    Serial.printf("Camera init failed: 0x%x\n", err);
  } else {
    Serial.println("Camera init OK");
  }
}

void connectWiFi() {
  WiFi.begin(ssid, password);

  Serial.print("Connecting");

  int attempts = 0;
  while (WiFi.status() != WL_CONNECTED && attempts < 40) {
    delay(500);
    Serial.print(".");
    attempts++;
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.println("\nWiFi Connected!");
    Serial.print("IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("\nWiFi connection FAILED");
  }
}

void initSDCard() {
  // Use 1-bit mode to free GPIO 4 (flash LED pin)
  if (!SD_MMC.begin("/sdcard", true)) {
    Serial.println("SD Card Mount Failed");
    return;
  }
  Serial.println("SD Card OK");
}

camera_fb_t* capturePhoto() {
  camera_fb_t *fb = esp_camera_fb_get();

  if (!fb) {
    Serial.println("Camera capture failed");
    return NULL;
  }

  Serial.printf("Captured %u bytes\n", fb->len);
  return fb;
}

void savePhotoToSD(camera_fb_t *fb) {
  File file = SD_MMC.open("/photo.jpg", FILE_WRITE);

  if (!file) {
    Serial.println("Failed to open file");
    return;
  }

  file.write(fb->buf, fb->len);
  file.close();

  Serial.println("Photo saved!");
}

void saveCSV(camera_fb_t *fb) {
  Serial.printf("Size: %u\n", fb->len);

  File file = SD_MMC.open("/photo.csv", FILE_WRITE);

  if (!file) {
    Serial.println("Failed to open CSV file");
    return;
  }

  for (size_t i = 0; i < fb->len; i++) {
    file.print(fb->buf[i]);
    if (i < fb->len - 1) {
      file.print(",");
    }
  }

  file.close();
  Serial.println("CSV saved!");
}

void sendToServer(camera_fb_t *fb) {
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("WiFi not connected, skipping send");
    return;
  }

  // Pre-allocate hex string: 2 hex chars + 1 space per byte
  size_t hexLen = fb->len * 3;
  char *hexBuf = (char *)malloc(hexLen + 1);
  if (!hexBuf) {
    Serial.println("Failed to allocate hex buffer");
    return;
  }

  // Build hex string in one pass (no String fragmentation)
  size_t pos = 0;
  for (size_t i = 0; i < fb->len; i++) {
    hexBuf[pos++] = hexChars[fb->buf[i] >> 4];
    hexBuf[pos++] = hexChars[fb->buf[i] & 0x0F];
    hexBuf[pos++] = ' ';
  }
  hexBuf[pos] = '\0';

  // Build JSON: { "hexData": "..." }
  // Overhead: ~20 chars for the JSON wrapper
  size_t jsonLen = hexLen + 20;
  char *jsonBuf = (char *)malloc(jsonLen + 1);
  if (!jsonBuf) {
    Serial.println("Failed to allocate JSON buffer");
    free(hexBuf);
    return;
  }

  snprintf(jsonBuf, jsonLen + 1, "{\"hexData\":\"%s\"}", hexBuf);
  free(hexBuf);

  Serial.printf("Sending %u bytes of JSON to server...\n", strlen(jsonBuf));
  Serial.printf("Free heap: %u\n", ESP.getFreeHeap());

  HTTPClient http;
  http.begin(serverUrl);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(15000);

  int responseCode = http.POST((uint8_t *)jsonBuf, strlen(jsonBuf));
  free(jsonBuf);

  Serial.printf("HTTP Response: %d\n", responseCode);

  if (responseCode > 0) {
    String response = http.getString();
    // Print first 500 chars to avoid flooding serial
    if (response.length() > 500) {
      Serial.println(response.substring(0, 500) + "...");
    } else {
      Serial.println(response);
    }
  } else {
    Serial.printf("Request failed, error: %s\n", http.errorToString(responseCode).c_str());
  }

  http.end();
}

void setup() {
  Serial.begin(115200);
  delay(1000);

  Serial.println("\n=== Rubber Duck Debugger - ESP32-CAM ===");
  Serial.printf("Target: %s\n", serverUrl);

  connectWiFi();
  initCamera();
  initSDCard();

  camera_fb_t *fb = capturePhoto();
  if (!fb) return;

  savePhotoToSD(fb);
  saveCSV(fb);
  sendToServer(fb);
  esp_camera_fb_return(fb);

  Serial.println("Done!");
}

void loop() {
}
