#!/usr/bin/env bash

ADDRESS=localhost:5080
TAG=latest
while getopts "t:u:" opt; do
  case ${opt} in
    u) ADDRESS="$OPTARG" ;;
    t) TAG="$OPTARG" ;;
    \?) echo "Invalid parameter"; exit 1;;
  esac
done

# docker compose build
docker compose build --push
