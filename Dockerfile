# Deno 2.8.x across the ecosystem (2.9 broke deno.land/x/socket_io for the
# services that serve it; this one does not, but stays on the shared pin).
# BusyBox in this image provides the `stty` the serial link needs.
FROM denoland/deno:alpine-2.8.2

WORKDIR /app

# dependencies first, so a code change does not re-download them
COPY deno.json deno.lock package.json ./
RUN deno install

COPY . .
# An edited vendor/ mirror must not ship. There is no upstream checkout in the
# build context, so this proves L1 only (and says "L2 SKIPPED").
RUN deno task vendor:verify && deno cache main.ts

EXPOSE 9000

# -A, not a narrower set: Deno refuses Deno.open("/dev/tty…") with anything
# less ("NotCapable: Requires all access"). For a tcp:// HOUR_METER_PORT,
# `deno task start:tcp` is enough.
CMD ["deno", "run", "-A", "main.ts"]
